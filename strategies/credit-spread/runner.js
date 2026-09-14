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
      // Alpaca reports an mleg fill as a SIGNED net price: negative when the combo was
      // opened for a net credit. Verified live 2026-08-13 - limit_price 0.13 filled with
      // filled_avg_price -0.13 (legs: sold QQQ 719P @0.25, bought 716P @0.12). Storing
      // that raw made entryCreditTotal negative in manageOpenTrades, which inverted BOTH
      // exit tests: the profit-target check became `pl >= -6.50`, true the instant the
      // spread opened. Every trade this bot ever placed (2026-08-06, 08-11, 08-13) closed
      // on "profit_target" within 0.4s of filling, each for a small loss. Normalise to a
      // positive credit, which is what the rest of the file assumes.
      const filledNet = Math.abs(parseFloat(order.filled_avg_price));
      trade.actualNetCredit = Number.isFinite(filledNet) && filledNet > 0 ? filledNet : trade.netCredit;
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
      // Closed outside the bot (dashboard Close button, Alpaca UI). removeTrade() alone
      // drops the P&L on the floor, which quietly disables the daily-loss circuit breaker
      // in canEnterNewTrade() - see the long note in ../../runner.js. Record the last
      // observed unrealised P&L instead: at most one 20s tick stale.
      const estimated = typeof trade.lastSeenPl === 'number' ? trade.lastSeenPl : 0;
      rm.recordExit(state, trade.orderId, estimated);
      log('TRADE_GONE', {
        underlying: trade.underlying, message: 'no legs found in account positions - closed outside the bot',
        pnl: estimated, pnlIsEstimate: true,
      });
      continue;
    }
    if (trade.lastSeenPl !== pl) {
      trade.lastSeenPl = pl;
      rm.saveState(state);
    }
    const entryCreditTotal = trade.actualNetCredit * 100 * trade.qty;
    // Defence in depth: both tests below are scaled by the credit, so a non-positive value
    // silently inverts them (see the sign note in reconcilePendingOrders). Never act on a
    // nonsensical credit - leave the spread to the 15:45 flatten instead.
    if (!(entryCreditTotal > 0)) {
      log('ERROR', {
        underlying: trade.underlying,
        message: `non-positive entry credit ${trade.actualNetCredit} - exit checks skipped, holding to force_close`,
      });
      continue;
    }
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

  // Letting /v2/account throw aborted the ENTIRE tick - profit-target/stop checks and the
  // 15:45 flatten included, which on a 0DTE spread is the last thing you want to skip
  // (assignment risk if it is still open at the close). Equity is only needed for the
  // max-risk-vs-equity entry check, so degrade: manage and flatten, skip new entries.
  let portfolioValue = null;
  try {
    const equity = parseFloat((await orders.getAccount()).equity);
    if (Number.isFinite(equity)) portfolioValue = equity;
  } catch (e) {
    log('ACCOUNT_UNAVAILABLE', { message: e.message, effect: 'managing open trades only, no new entries this tick' });
  }
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
  if (portfolioValue !== null && t >= cfg.ENTRY_WINDOW_START && t < cfg.ENTRY_WINDOW_END) {
    for (const symbol of cfg.SYMBOLS) {
      if (state.tradedSymbols.includes(symbol)) continue;
      await tryEnter(symbol, portfolioValue, state);
    }
  }
}

async function main() {
  log('START', { dryRun: DRY_RUN, strategy: 'CreditSpread0DTE', symbols: cfg.SYMBOLS });
  // setInterval fires on a fixed clock regardless of whether the previous tick finished.
  // A slow tick (broker 5xx/timeout backoff) could otherwise run concurrently with the
  // next one and double-enter, since a position is only recorded in state AFTER its order
  // is placed. Skip instead of stacking.
  let tickInFlight = false;
  const runTick = async () => {
    if (tickInFlight) {
      log('TICK_SKIPPED', { reason: 'previous tick still running' });
      return;
    }
    tickInFlight = true;
    try {
      await tick();
    } catch (e) {
      log('ERROR', { message: e.message });
    } finally {
      tickInFlight = false;
    }
  };
  await runTick();
  setInterval(runTick, POLL_MS);
}

main();
