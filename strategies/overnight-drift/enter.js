// Overnight drift strategy - ENTRY leg. Run once daily near 15:55 ET (see the scheduled
// task registration) via `node --env-file=strategies/overnight-drift/.env.overnight
// strategies/overnight-drift/enter.js`. For each symbol in cfg.UNIVERSE: if today's
// open->now return is a strong-enough up move, buy a call (or debit spread if the ATM
// single is unaffordable), to be sold at tomorrow's open by exit.js.
//
// LONG ONLY, deliberately: the validated backtest (scripts/strategy-overnight-sweep.js,
// 2026-07-28) found the symmetric short/put side on a down day tested NEGATIVE (-12.23bp
// vs +13.80bp for the long side) - implementing it anyway would be shipping a rejected
// idea. A strong down day is simply not traded by this bot.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const client = require('./alpacaClient');
const orders = require('./orders');
const contracts = require('./contracts');
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

async function getTodayBars(symbol) {
  const res = await client.data('/v2/stocks/bars', {
    params: {
      symbols: symbol, timeframe: cfg.TIMEFRAME,
      start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      limit: 200, adjustment: 'split', feed: 'iex',
    },
  });
  const bars = (res.bars && res.bars[symbol]) || [];
  const today = todayET();
  return bars.filter((b) => new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today);
}

async function main() {
  const state = rm.loadState();
  if (state.lastEnterDate === todayET()) {
    log('SKIP', { reason: 'already entered today', date: todayET() });
    return;
  }

  const account = await orders.getAccount();
  const portfolioValue = parseFloat(account.equity);

  for (const symbol of cfg.UNIVERSE) {
    const bars = await getTodayBars(symbol);
    if (bars.length < 2) { log('NO_DATA', { symbol }); continue; }
    const openPrice = bars[0].o;
    const lastPrice = bars[bars.length - 1].c;
    const todayReturn = (lastPrice - openPrice) / openPrice;

    if (todayReturn < cfg.TODAY_RETURN_THRESHOLD) {
      log('NO_SIGNAL', { symbol, todayReturn: +(todayReturn * 100).toFixed(2) });
      continue;
    }

    const gate = rm.canEnterNewTrade(state.openPositions.length, portfolioValue);
    if (!gate.allowed) {
      log('SIGNAL_BLOCKED', { symbol, reasons: gate.reasons });
      continue;
    }

    const budget = rm.tradeBudget(portfolioValue);
    const { structure, reason } = await contracts.selectStructure(symbol, 'bullish', lastPrice, budget, contracts.getLatestOptionQuote);
    if (!structure) {
      log('NO_STRUCTURE', { symbol, budget: budget.toFixed(0), reason });
      continue;
    }

    let limitPrice;
    if (structure.kind === 'single') {
      limitPrice = orders.entryLimitFromQuote(structure.quote);
    } else {
      const netMid = structure.quote.long.mid - structure.quote.short.mid;
      const netWorst = structure.quote.long.ask - structure.quote.short.bid;
      limitPrice = orders.roundTick(netMid + 0.25 * (netWorst - netMid));
    }
    if (limitPrice <= 0) { log('NO_STRUCTURE', { symbol, reason: 'non-positive limit price' }); continue; }

    let orderId = `dry-${Date.now()}`;
    if (!DRY_RUN) {
      const placed = structure.kind === 'single'
        ? await orders.buyToOpenLimit(structure.legs[0].symbol, structure.qty, limitPrice)
        : await orders.openSpreadLimit(structure.legs, structure.qty, limitPrice);
      orderId = placed.id;
    }

    rm.recordEntry(state, {
      underlying: symbol,
      kind: structure.kind,
      legs: structure.legs,
      qty: structure.qty,
      direction: 'bullish',
      entryDebit: limitPrice,
      todayReturn: +(todayReturn * 100).toFixed(2),
      orderId,
      status: DRY_RUN ? 'open' : 'pending',
      enteredAt: new Date().toISOString(),
    });
    log('ENTRY_ORDER', { symbol, kind: structure.kind, qty: structure.qty, limitPrice, todayReturn: +(todayReturn * 100).toFixed(2), dryRun: DRY_RUN });
  }

  state.lastEnterDate = todayET();
  rm.saveState(state);

  await settlePendingOrders(state);
  log('ENTER_DONE', { date: todayET(), openPositions: state.openPositions.length });
}

// This script used to place its orders and exit immediately, leaving every order recorded
// as an open position with status 'pending' until the next morning's exit.js reconciled it.
// The orders are `day` limits placed at 15:55 ET, so they resolve one way or the other by
// the 16:00 close - and they frequently expire unfilled (3 of the 7 placed between
// 2026-08-03 and 2026-08-13). In between, state.json overstated the book: on 2026-08-13 it
// recorded 3 open positions when only COIN and PLTR ever filled. That is not cosmetic -
// canEnterNewTrade() counts openPositions against MAX_CONCURRENT_POSITIONS, so a phantom
// position silently consumes a slot the next session, and the dashboard reports it as real.
//
// Waiting through the close costs a few idle minutes in a scheduled task and resolves every
// order definitively. Read-only polling: nothing is cancelled or re-priced here.
async function settlePendingOrders(state) {
  if (DRY_RUN) return;
  const DEADLINE = Date.now() + 8 * 60 * 1000; // hard stop well past the 16:00 expiry
  const POLL_MS = 20 * 1000;

  while (Date.now() < DEADLINE) {
    const pending = state.openPositions.filter((p) => p.status === 'pending');
    if (pending.length === 0) return;

    for (const trade of pending) {
      let order;
      try {
        order = await orders.getOrder(trade.orderId);
      } catch (e) {
        log('ERROR', { message: `order lookup ${trade.orderId}: ${e.message}` });
        continue;
      }
      if (order.status === 'filled') {
        trade.status = 'open';
        // Same field exit.js overwrites on its own reconcile pass, so the two paths leave
        // state in an identical shape whichever one resolves the order first.
        const limitPrice = trade.entryDebit;
        trade.entryDebit = parseFloat(order.filled_avg_price) || trade.entryDebit;
        rm.saveState(state);
        log('ENTRY', {
          symbol: trade.underlying, kind: trade.kind, qty: trade.qty,
          premium: trade.entryDebit, limitPrice,
        });
      } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
        rm.removeTrade(state, trade.orderId);
        log('ENTRY_UNFILLED', { symbol: trade.underlying, orderId: trade.orderId, status: order.status });
      }
    }

    if (state.openPositions.some((p) => p.status === 'pending')) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const stuck = state.openPositions.filter((p) => p.status === 'pending');
  if (stuck.length) {
    // Left in state deliberately rather than guessed at - exit.js reconciles pending orders
    // too, so an unresolved one is picked up next session instead of being dropped here.
    log('PENDING_UNRESOLVED', { count: stuck.length, symbols: stuck.map((p) => p.underlying) });
  }
}

main().catch((e) => { log('ERROR', { message: e.message }); process.exit(1); });
