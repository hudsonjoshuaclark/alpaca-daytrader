// Trader-mimicry EXIT check. Run once daily near the close (15:50 ET) - this is a multi-
// day swing hold, not an intraday strategy, so a single daily check is enough. Closes a
// position on whichever comes first: cfg.PROFIT_TARGET_PCT, cfg.STOP_PCT, or
// cfg.HOLDING_PERIOD_DAYS weekdays held (approximate trading-day count - not a full
// market-holiday calendar, close enough for a 5-day-scale exit rule).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const orders = require('./orders');
const rm = require('./riskManager');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');

function log(event, details) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function tradeUnrealizedPl(trade, positionsBySymbol) {
  let pl = 0, found = 0;
  for (const leg of trade.legs) {
    const pos = positionsBySymbol.get(leg.symbol);
    if (!pos) continue;
    pl += parseFloat(pos.unrealized_pl);
    found += 1;
  }
  return found === 0 ? null : pl;
}

// Weekday count between two dates - an approximation of trading days (doesn't account
// for market holidays, which is fine at this strategy's ~5-day timescale).
function weekdaysBetween(fromIso, toDate) {
  const from = new Date(fromIso);
  let count = 0;
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

async function main() {
  const state = rm.loadState();

  // reconcile pending entry orders
  for (const trade of [...state.openPositions]) {
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
      trade.entryDebit = parseFloat(order.filled_avg_price) || trade.entryDebit;
      rm.saveState(state);
      log('ENTRY', { symbol: trade.underlying, kind: trade.kind, qty: trade.qty, premium: trade.entryDebit, thesis: trade.thesis });
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { underlying: trade.underlying, orderId: trade.orderId, status: order.status });
    } else if (Date.now() - new Date(trade.enteredAt).getTime() > 2 * 24 * 60 * 60 * 1000) {
      // stale pending order past a couple days is abnormal - cancel and drop rather than
      // let it linger unmonitored (a day-tif limit order shouldn't still be pending anyway)
      try { await orders.cancelOrder(trade.orderId); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_CANCEL_STALE', { underlying: trade.underlying, orderId: trade.orderId });
    }
  }

  const positions = DRY_RUN ? [] : await orders.getAllPositions();
  const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));
  const now = new Date();

  for (const trade of [...state.openPositions]) {
    if (trade.status !== 'open') continue;
    const pl = tradeUnrealizedPl(trade, positionsBySymbol);
    if (pl === null) {
      rm.removeTrade(state, trade.orderId);
      log('TRADE_GONE', { underlying: trade.underlying, message: 'no legs found in account positions' });
      continue;
    }

    const costBasis = trade.entryDebit * 100 * trade.qty;
    const plPct = costBasis > 0 ? pl / costBasis : 0;
    const daysHeld = weekdaysBetween(trade.enteredAt, now);

    let reason = null;
    if (plPct >= cfg.PROFIT_TARGET_PCT) reason = 'profit_target';
    else if (plPct <= -cfg.STOP_PCT) reason = 'stop';
    else if (daysHeld >= cfg.HOLDING_PERIOD_DAYS) reason = 'holding_period';

    if (!reason) {
      log('HOLD', { underlying: trade.underlying, plPct: +(plPct * 100).toFixed(1), daysHeld });
      continue;
    }

    if (!DRY_RUN) {
      if (trade.kind === 'spread') {
        await orders.closeSpreadMarket(trade.legs, trade.qty);
      } else {
        await orders.sellToClose(trade.legs[0].symbol, trade.qty);
      }
    }
    rm.recordExit(state, trade.orderId, pl);
    log('EXIT', { symbol: trade.legs[0].symbol, underlying: trade.underlying, kind: trade.kind, qty: trade.qty, pnl: pl, reason, daysHeld, dryRun: DRY_RUN });
  }
}

main().catch((e) => { log('ERROR', { message: e.message }); process.exit(1); });
