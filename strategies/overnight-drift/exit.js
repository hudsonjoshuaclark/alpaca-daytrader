// Overnight drift strategy - EXIT leg. Run once daily near 09:35 ET (a few minutes after
// the open, letting the opening auction settle) via `node --env-file=strategies/overnight-
// drift/.env.overnight strategies/overnight-drift/exit.js`. Reconciles last night's entry
// orders (fill vs cancel), then market-closes every open position - this strategy's whole
// edge is being flat again shortly after the open, not chasing a better exit price.
const fs = require('fs');
const path = require('path');
const orders = require('./orders');
const rm = require('./riskManager');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');

function log(event, details) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Sum of unrealized P&L across a trade's legs, from a symbol->position map. Returns null
// if no legs are found (position already gone).
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

async function main() {
  const state = rm.loadState();
  if (state.lastExitDate === todayET()) {
    log('SKIP', { reason: 'already exited today', date: todayET() });
    return;
  }

  // reconcile pending entry orders from last night
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
      log('ENTRY', { symbol: trade.underlying, kind: trade.kind, qty: trade.qty, premium: trade.entryDebit });
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { underlying: trade.underlying, orderId: trade.orderId, status: order.status });
    } else {
      // still pending past the overnight hold (shouldn't normally happen for a day-tif
      // order placed the prior afternoon, but cancel and drop it rather than carry it
      // into a second night unmonitored).
      try { await orders.cancelOrder(trade.orderId); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_CANCEL_STALE', { underlying: trade.underlying, orderId: trade.orderId });
    }
  }

  const positions = DRY_RUN ? [] : await orders.getAllPositions();
  const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));

  for (const trade of [...state.openPositions]) {
    if (trade.status !== 'open') continue;
    const pnl = tradeUnrealizedPl(trade, positionsBySymbol);
    if (pnl === null) {
      rm.removeTrade(state, trade.orderId);
      log('TRADE_GONE', { underlying: trade.underlying, message: 'no legs found in account positions' });
      continue;
    }
    if (!DRY_RUN) {
      if (trade.kind === 'spread') {
        await orders.closeSpreadMarket(trade.legs, trade.qty);
      } else {
        await orders.sellToClose(trade.legs[0].symbol, trade.qty);
      }
    }
    rm.recordExit(state, trade.orderId, pnl);
    log('EXIT', { symbol: trade.legs[0].symbol, underlying: trade.underlying, kind: trade.kind, qty: trade.qty, pnl, dryRun: DRY_RUN });
  }

  state.lastExitDate = todayET();
  rm.saveState(state);
  log('EXIT_DONE', { date: todayET(), realizedPnL: state.realizedPnL });
}

main().catch((e) => { log('ERROR', { message: e.message }); process.exit(1); });
