// 0DTE put credit spread strategy - continuous runner (unlike overnight-drift/trader-
// mimicry's twice-daily scripts, this needs intraday polling since profit-target/stop
// conditions on a same-day-expiring spread can hit at any point during the day).
// Validated 2026-07-31 (see config.js header comment for the real backtest numbers).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const orders = require('./orders');
const contracts = require('./contracts');
const rm = require('./riskManager');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');
const HEARTBEAT_FILE = path.join(__dirname, 'logs', 'heartbeat.json');
const POLL_MS = 20 * 1000;

function writeHeartbeat() {
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: new Date().toISOString() }));
}

function log(event, details) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function isMarketHours() {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return false;
  const t = rm.nowET();
  return t >= '09:30' && t < '16:00';
}

async function getLatestUnderlyingPrice(symbol) {
  const client = require('./alpacaClient');
  // limit:1 without a start time returns an arbitrary early bar, not the most recent one
  // (confirmed live - it returned an 08:05 ET pre-market bar at 15:50 ET) - an explicit
  // recent start window plus taking the LAST bar is what actually gets "latest."
  const res = await client.data('/v2/stocks/bars', {
    params: {
      symbols: symbol, timeframe: '1Min',
      start: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      limit: 50, adjustment: 'split', feed: 'iex',
    },
  });
  const bars = (res.bars && res.bars[symbol]) || [];
  return bars.length ? bars[bars.length - 1].c : null;
}

function tradeUnrealizedPl(trade, positionsBySymbol) {
  let pl = 0, found = 0;
  for (const sym of [trade.shortLeg.symbol, trade.longLeg.symbol]) {
    const pos = positionsBySymbol.get(sym);
    if (!pos) continue;
    pl += parseFloat(pos.unrealized_pl);
    found += 1;
  }
  return found === 0 ? null : pl;
}

async function closeTrade(trade, pnl, reason, state) {
  if (!DRY_RUN) {
    await orders.closeCreditSpreadMarket([trade.shortLeg, trade.longLeg], trade.qty);
  }
  rm.recordExit(state, trade.orderId, pnl);
  log('EXIT', { underlying: trade.underlying, reason, qty: trade.qty, pnl, dryRun: DRY_RUN });
}

async function reconcilePendingOrders(state) {
  for (const trade of [...state.openTrades]) {
    if (trade.status !== 'pending') continue;
    if (DRY_RUN) { trade.status = 'open'; rm.saveState(state); continue; }
    let order;
    try {
      order = await orders.getOrder(trade.orderId);
    } catch (e) {
      log('ERROR', { message: `order lookup ${trade.orderId}: ${e.message}` });
      continue;
    }
    if (order.status === 'filled') {
      trade.status = 'open';
      trade.actualNetCredit = parseFloat(order.filled_avg_price) || trade.netCredit;
      rm.saveState(state);
      log('ENTRY', { underlying: trade.underlying, shortLeg: trade.shortLeg.symbol, longLeg: trade.longLeg.symbol, qty: trade.qty, netCredit: trade.actualNetCredit });
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { underlying: trade.underlying, orderId: trade.orderId, status: order.status });
    } else if (Date.now() - new Date(trade.enteredAt).getTime() > 3 * 60 * 1000) {
      try { await orders.cancelOrder(trade.orderId); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
      log('ENTRY_CANCEL_STALE', { underlying: trade.underlying, orderId: trade.orderId });
    }
  }
}

async function flattenAll(state, positionsBySymbol) {
  for (const trade of [...state.openTrades]) {
    if (trade.status === 'pending') {
      if (!DRY_RUN) {
        try { await orders.cancelOrder(trade.orderId); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
      }
      rm.removeTrade(state, trade.orderId);
      continue;
    }
    const pnl = tradeUnrealizedPl(trade, positionsBySymbol) ?? 0;
    await closeTrade(trade, pnl, 'force_close', state);
  }
  // safety sweep: anything in the account not tracked in state (both legs of any spread)
  for (const pos of positionsBySymbol.values()) {
    const qty = Math.abs(parseInt(pos.qty, 10));
    if (qty <= 0) continue;
    if (!DRY_RUN) await orders.closePositionMarket(pos.symbol);
    log('FORCE_FLATTEN', { symbol: pos.symbol, qty, pnl: parseFloat(pos.unrealized_pl), untracked: true });
  }
}

async function manageOpenTrades(state, positionsBySymbol) {
  for (const trade of [...state.openTrades]) {
    if (trade.status !== 'open') continue;
    const pl = tradeUnrealizedPl(trade, positionsBySymbol);
    if (pl === null) {
      rm.removeTrade(state, trade.orderId);
      log('TRADE_GONE', { underlying: trade.underlying, message: 'no legs found in account positions' });
      continue;
    }
    const entryCreditTotal = trade.actualNetCredit * 100 * trade.qty;
    if (pl >= entryCreditTotal * cfg.PROFIT_TARGET_PCT) {
      await closeTrade(trade, pl, 'profit_target', state);
      continue;
    }
    if (pl <= -entryCreditTotal * (cfg.STOP_MULTIPLE - 1)) {
      await closeTrade(trade, pl, 'stop', state);
      continue;
    }
  }
}

async function tryEnter(symbol, portfolioValue, state) {
  const gate = rm.canEnterNewTrade(state, portfolioValue, symbol);
  if (!gate.allowed) {
    log('SIGNAL_BLOCKED', { symbol, reasons: gate.reasons });
    return;
  }

  const price = await getLatestUnderlyingPrice(symbol);
  if (!price) { log('NO_STRUCTURE', { symbol, reason: 'no current price available' }); return; }

  const { structure, reason } = await contracts.selectCreditSpread(symbol, price);
  if (!structure) {
    log('NO_STRUCTURE', { symbol, reason });
    if (!state.tradedSymbols.includes(symbol)) { state.tradedSymbols.push(symbol); rm.saveState(state); }
    return;
  }

  const maxRiskTotal = structure.maxRisk * 100 * cfg.QTY_PER_SPREAD;
  if (maxRiskTotal > portfolioValue * cfg.MAX_RISK_PCT_OF_EQUITY) {
    log('NO_STRUCTURE', { symbol, reason: `max risk $${maxRiskTotal.toFixed(0)} > ${(cfg.MAX_RISK_PCT_OF_EQUITY * 100).toFixed(0)}% of equity` });
    if (!state.tradedSymbols.includes(symbol)) { state.tradedSymbols.push(symbol); rm.saveState(state); }
    return;
  }

  const limitCredit = orders.roundTick(structure.netCredit * 0.9); // ask for a bit less than the conservative estimate to improve fill odds
  let orderId = `dry-${Date.now()}`;
  if (!DRY_RUN) {
    const placed = await orders.openCreditSpreadLimit([structure.shortLeg, structure.longLeg], cfg.QTY_PER_SPREAD, limitCredit);
    orderId = placed.id;
  }

  rm.recordEntry(state, {
    underlying: symbol,
    shortLeg: structure.shortLeg,
    longLeg: structure.longLeg,
    qty: cfg.QTY_PER_SPREAD,
    netCredit: limitCredit,
    actualNetCredit: limitCredit,
    maxRisk: structure.maxRisk,
    orderId,
    status: DRY_RUN ? 'open' : 'pending',
    enteredAt: new Date().toISOString(),
  });
  log('ENTRY_ORDER', { symbol, shortStrike: structure.shortLeg.strike, longStrike: structure.longLeg.strike, qty: cfg.QTY_PER_SPREAD, netCredit: limitCredit, maxRisk: structure.maxRisk, dryRun: DRY_RUN });
}

async function tick() {
  writeHeartbeat();
  if (!isMarketHours()) return;

  const account = await orders.getAccount();
  const portfolioValue = parseFloat(account.equity);
  const state = rm.loadState();

  await reconcilePendingOrders(state);

  const livePositions = DRY_RUN ? [] : await orders.getAllPositions();
  const positionsBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));

  if (rm.nowET() >= cfg.FORCE_CLOSE_AT) {
    await flattenAll(state, positionsBySymbol);
    const fresh = rm.loadState();
    if (!fresh.dayEndLogged) {
      fresh.dayEndLogged = true;
      rm.saveState(fresh);
      log('DAY_END', { trades: fresh.trades, realizedPnL: fresh.realizedPnL });
    }
    return;
  }

  await manageOpenTrades(state, positionsBySymbol);

  const t = rm.nowET();
  if (t >= cfg.ENTRY_WINDOW_START && t < cfg.ENTRY_WINDOW_END) {
    for (const symbol of cfg.SYMBOLS) {
      if (state.tradedSymbols.includes(symbol)) continue;
      await tryEnter(symbol, portfolioValue, state);
    }
  }
}

async function main() {
  log('START', { dryRun: DRY_RUN, strategy: 'CreditSpread0DTE', symbols: cfg.SYMBOLS });
  await tick().catch((e) => log('ERROR', { message: e.message }));
  setInterval(() => {
    tick().catch((e) => log('ERROR', { message: e.message }));
  }, POLL_MS);
}

main();
