// RSI-pullback swing-signal strategy - continuous runner, direct stock shares (not options).
// Validated 2026-08-02 (see config.js header for the real backtest numbers). Scans the
// watchlist for entries during the entry window, manages every open position's stop-loss/
// take-profit every tick via Alpaca's live unrealized_plpc, force-flattens at FORCE_CLOSE_AT.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const orders = require('./orders');
const rm = require('./riskManager');
const { ema, rsi } = require('./indicators');
const ratchet = require('../../lib/ratchet'); // pure math, no config/keys - safe to share
const watchlist = require('./watchlist');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');
const HEARTBEAT_FILE = path.join(__dirname, 'logs', 'heartbeat.json');
const POLL_MS = 60 * 1000; // 5-min bars only update every 5 min - no need to poll faster for signals; stop/target checks (cheap, from live position data) still get checked every tick

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

async function getRecentBars(symbols) {
  const client = require('./alpacaClient');
  const res = await client.data('/v2/stocks/bars', {
    params: {
      symbols: symbols.join(','), timeframe: cfg.TIMEFRAME,
      start: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      limit: 10000, adjustment: 'split', feed: 'iex',
    },
  });
  return res.bars || {};
}

// price above EMA(50) (uptrend filter) + RSI(14) crosses back up through 30 (pullback entry),
// checked on the latest completed bar - matches scripts/strategy-swing-sweep.js exactly.
function computeSignal(barArray) {
  if (!barArray || barArray.length < cfg.EMA_TREND + 2) return null;
  const closes = barArray.map((b) => b.c);
  const trendEma = ema(closes, cfg.EMA_TREND);
  const rsiVals = rsi(closes, cfg.RSI_PERIOD);
  const i = closes.length - 1;
  if (trendEma[i] == null || rsiVals[i - 1] == null || rsiVals[i] == null) return null;
  const price = closes[i];
  const inUptrend = price > trendEma[i];
  const crossedUpThroughOversold = rsiVals[i - 1] <= cfg.RSI_OVERSOLD && rsiVals[i] > cfg.RSI_OVERSOLD;
  if (inUptrend && crossedUpThroughOversold) return { price };
  return null;
}

async function closeTrade(trade, pnl, reason, state) {
  if (!DRY_RUN) {
    await orders.closePositionMarket(trade.symbol);
  }
  rm.recordExit(state, trade.orderId, pnl);
  log('EXIT', { symbol: trade.symbol, reason, qty: trade.qty, pnl, dryRun: DRY_RUN });
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
      trade.actualEntryPrice = parseFloat(order.filled_avg_price) || trade.entryPrice;
      rm.saveState(state);
      log('ENTRY', { symbol: trade.symbol, qty: trade.qty, entryPrice: trade.actualEntryPrice });
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { symbol: trade.symbol, orderId: trade.orderId, status: order.status });
    } else if (Date.now() - new Date(trade.enteredAt).getTime() > 3 * 60 * 1000) {
      try { await orders.cancelOrder(trade.orderId); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
      log('ENTRY_CANCEL_STALE', { symbol: trade.symbol, orderId: trade.orderId });
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
    const pos = positionsBySymbol.get(trade.symbol);
    const pnl = pos ? parseFloat(pos.unrealized_pl) : 0;
    await closeTrade(trade, pnl, 'force_close', state);
  }
  // safety sweep: anything in the account not tracked in state
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
    const pos = positionsBySymbol.get(trade.symbol);
    if (!pos) {
      // Closed outside the bot (dashboard Close button, Alpaca UI). removeTrade() alone
      // drops the P&L on the floor, which quietly disables this bot's DAILY_LOSS_STOP_PCT
      // circuit breaker - see the long note in ../../runner.js. Record the last observed
      // unrealised P&L instead: at most one 60s tick stale.
      const estimated = typeof trade.lastSeenPl === 'number' ? trade.lastSeenPl : 0;
      rm.recordExit(state, trade.orderId, estimated);
      log('TRADE_GONE', {
        symbol: trade.symbol, message: 'no position found in account - closed outside the bot',
        pnl: estimated, pnlIsEstimate: true,
      });
      continue;
    }
    const plpc = parseFloat(pos.unrealized_plpc);
    const pnl = parseFloat(pos.unrealized_pl);
    if (trade.lastSeenPl !== pnl) {
      trade.lastSeenPl = pnl;
      rm.saveState(state);
    }

    if (!cfg.RATCHET_ENABLED) {
      // Original validated behaviour: fixed stop, and the target closes the trade.
      if (plpc <= -cfg.STOP_LOSS_PCT) {
        await closeTrade(trade, pnl, 'stop', state);
        continue;
      }
      if (plpc >= cfg.TAKE_PROFIT_PCT) {
        await closeTrade(trade, pnl, 'target', state);
        continue;
      }
      continue;
    }

    // Ratcheting stop/target. Reaching the target advances a rung and re-arms higher
    // instead of closing, so only the stop ever ends the trade. minStopRung is 0 here
    // because rung 0's stop IS this bot's -STOP_LOSS_PCT stop - identical until the first
    // target is reached.
    const r = ratchet.evaluate({
      rung: trade.rung || 0,
      gain: plpc,
      step: cfg.TAKE_PROFIT_PCT,
      stopDistance: cfg.STOP_LOSS_PCT,
      maxRungs: cfg.RATCHET_MAX_RUNGS,
    });
    if (r.advanced) {
      trade.rung = r.rung;
      rm.saveState(state);
      log('RATCHET', {
        symbol: trade.symbol, rung: r.rung, gainPct: +(plpc * 100).toFixed(2),
        stopPct: +(r.stop * 100).toFixed(2), targetPct: +(r.target * 100).toFixed(2), pnl,
      });
    }
    if (r.stopped) {
      await closeTrade(trade, pnl, r.rung > 0 ? 'trail_stop' : 'stop', state);
      continue;
    }
  }
}

async function tryEnter(symbol, price, portfolioValue, state) {
  const gate = rm.canEnterNewTrade(state, portfolioValue, symbol);
  if (!gate.allowed) {
    log('SIGNAL_BLOCKED', { symbol, reasons: gate.reasons });
    return;
  }

  const qty = Math.floor((portfolioValue * cfg.RISK_PCT_PER_TRADE) / price);
  if (qty < 1) {
    log('NO_STRUCTURE', { symbol, reason: `budget too small for 1 share at $${price.toFixed(2)}` });
    return;
  }

  let orderId = `dry-${Date.now()}-${symbol}`;
  if (!DRY_RUN) {
    const placed = await orders.openMarketOrder(symbol, qty, 'buy');
    orderId = placed.id;
  }

  rm.recordEntry(state, {
    symbol,
    qty,
    entryPrice: price,
    actualEntryPrice: price,
    orderId,
    status: DRY_RUN ? 'open' : 'pending',
    enteredAt: new Date().toISOString(),
  });
  log('SIGNAL_ENTRY', { symbol, qty, signalPrice: price, dryRun: DRY_RUN });
}

async function scanForSignals(state, portfolioValue) {
  const alreadyIn = new Set(state.openTrades.map((t) => t.symbol));
  const candidates = watchlist.filter((s) => !alreadyIn.has(s));
  if (candidates.length === 0) return;

  let bars;
  try {
    bars = await getRecentBars(candidates);
  } catch (e) {
    log('ERROR', { message: `bar fetch failed: ${e.message}` });
    return;
  }

  for (const symbol of candidates) {
    const signal = computeSignal(bars[symbol]);
    if (!signal) continue;
    await tryEnter(symbol, signal.price, portfolioValue, state);
  }
}

async function tick() {
  writeHeartbeat();
  if (!isMarketHours()) return;

  // Letting /v2/account throw aborted the ENTIRE tick - stop/target checks and the 15:45
  // flatten included. This bot lost 16 consecutive minutes of position management to that
  // on 2026-08-13 (every tick 12:56-13:11 ET timed out on this one call). Equity is only
  // needed to size a new entry, so degrade: manage and flatten what's open, skip entries.
  let portfolioValue = null;
  try {
    const equity = parseFloat((await orders.getAccount()).equity);
    if (Number.isFinite(equity)) portfolioValue = equity;
  } catch (e) {
    log('ACCOUNT_UNAVAILABLE', { message: e.message, effect: 'managing open trades only, no new entries this tick' });
  }
  const state = rm.loadState();
  if (state.startEquity === null && portfolioValue !== null) {
    state.startEquity = portfolioValue;
    rm.saveState(state);
  }

  await reconcilePendingOrders(state);

  const livePositions = DRY_RUN ? [] : await orders.getAllPositions();
  const positionsBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));

  if (rm.nowET() >= cfg.FORCE_CLOSE_AT) {
    await flattenAll(state, positionsBySymbol);
    const fresh = rm.loadState();
    if (!fresh.dayEndLogged) {
      fresh.dayEndLogged = true;
      rm.saveState(fresh);
      log('DAY_END', { trades: fresh.trades, realizedPnL: fresh.realizedPnL, startEquity: fresh.startEquity });
    }
    return;
  }

  await manageOpenTrades(state, positionsBySymbol);

  const t = rm.nowET();
  if (portfolioValue !== null && t >= cfg.ENTRY_WINDOW_START && t < cfg.ENTRY_WINDOW_END) {
    await scanForSignals(state, portfolioValue);
  }
}

async function main() {
  log('START', { dryRun: DRY_RUN, strategy: 'SwingSignalsRSI', watchlistSize: watchlist.length });
  // setInterval fires on a fixed clock regardless of whether the previous tick finished.
  // This runner scans a 56-name watchlist, so a broker slowdown makes an overrun the most
  // likely of the three bots — and a position is only recorded in state AFTER its order is
  // placed, so overlapping ticks could double-enter. Skip instead of stacking.
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
