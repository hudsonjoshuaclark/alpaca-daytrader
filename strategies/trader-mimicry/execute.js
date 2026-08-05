// Trader-mimicry EXECUTE leg. Run once daily shortly after the open (09:40 ET, once
// quotes are live). This is a PLAIN-CODE script with zero LLM involvement - it reads
// logs/proposal.json (written by the agent via propose.ps1) and either places an order
// or doesn't. Every risk cap is enforced here, in code, not trusted to the agent's
// self-restraint: today's-proposal freshness, MAX_NEW_ENTRIES_PER_DAY,
// MAX_CONCURRENT_POSITIONS, the drawdown guardrail, and the same liquidity/spread/
// affordability gates the other two bots use.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const client = require('./alpacaClient');
const orders = require('./orders');
const contracts = require('./contracts');
const rm = require('./riskManager');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');
const PROPOSAL_FILE = path.join(__dirname, 'logs', 'proposal.json');

function log(event, details) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function getLatestPrice(symbol) {
  const res = await client.data('/v2/stocks/bars', {
    params: { symbols: symbol, timeframe: '1Min', limit: 1, adjustment: 'split', feed: 'iex' },
  });
  const bars = (res.bars && res.bars[symbol]) || [];
  return bars.length ? bars[bars.length - 1].c : null;
}

async function main() {
  if (!fs.existsSync(PROPOSAL_FILE)) {
    log('NO_PROPOSAL', { reason: 'proposal.json does not exist - propose.ps1 may not have run' });
    return;
  }
  const proposal = JSON.parse(fs.readFileSync(PROPOSAL_FILE, 'utf8'));

  if (proposal.date !== todayET()) {
    log('STALE_PROPOSAL', { proposalDate: proposal.date, today: todayET() });
    return;
  }
  if (!proposal.proposal) {
    log('NO_TRADE_TODAY', { reasoning: proposal.reasoning });
    return;
  }

  const { symbol, direction, thesis } = proposal.proposal;
  if (!symbol || (direction !== 'bullish' && direction !== 'bearish')) {
    log('INVALID_PROPOSAL', { proposal: proposal.proposal });
    return;
  }

  const state = rm.loadState();

  if (state.openPositions.some((p) => p.underlying === symbol)) {
    log('ALREADY_HOLDING', { symbol });
    return;
  }

  const account = await orders.getAccount();
  const portfolioValue = parseFloat(account.equity);

  const gate = rm.canEnterNewTrade(state, portfolioValue);
  if (!gate.allowed) {
    log('SIGNAL_BLOCKED', { symbol, reasons: gate.reasons });
    return;
  }

  const price = await getLatestPrice(symbol);
  if (!price) {
    log('NO_STRUCTURE', { symbol, reason: 'no current price available' });
    return;
  }

  const budget = rm.tradeBudget(portfolioValue);
  const { structure, reason } = await contracts.selectStructure(symbol, direction, price, budget, contracts.getLatestOptionQuote);
  if (!structure) {
    log('NO_STRUCTURE', { symbol, budget: budget.toFixed(0), reason });
    return;
  }

  let limitPrice;
  if (structure.kind === 'single') {
    limitPrice = orders.entryLimitFromQuote(structure.quote);
  } else {
    const netMid = structure.quote.long.mid - structure.quote.short.mid;
    const netWorst = structure.quote.long.ask - structure.quote.short.bid;
    limitPrice = orders.roundTick(netMid + 0.25 * (netWorst - netMid));
  }
  if (limitPrice <= 0) { log('NO_STRUCTURE', { symbol, reason: 'non-positive limit price' }); return; }

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
    direction,
    entryDebit: limitPrice,
    thesis,
    orderId,
    status: DRY_RUN ? 'open' : 'pending',
    enteredAt: new Date().toISOString(),
    holdUntilTradingDay: null, // set once the entry fill is confirmed - see reconcile in exit.js
  });
  rm.recordEntryUsed(state);
  log('ENTRY_ORDER', { symbol, kind: structure.kind, qty: structure.qty, limitPrice, direction, thesis, dryRun: DRY_RUN });
}

main().catch((e) => { log('ERROR', { message: e.message }); process.exit(1); });
