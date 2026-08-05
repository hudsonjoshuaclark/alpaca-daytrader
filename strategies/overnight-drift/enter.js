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
  log('ENTER_DONE', { date: todayET(), openPositions: state.openPositions.length });
}

main().catch((e) => { log('ERROR', { message: e.message }); process.exit(1); });
