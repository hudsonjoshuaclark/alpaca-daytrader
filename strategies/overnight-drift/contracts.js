// Contract selection for the overnight strategy - adapted from ../../lib/contracts.js with
// one critical difference: the ORB bot's getNearestChain uses expiration_date_gte=today,
// which is correct for a same-day round trip but WRONG here - a 0DTE option bought at
// today's close would expire worthless before tomorrow's open ever arrives. This strategy
// needs an expiration that survives the overnight hold, so it filters to expiration_date
// STRICTLY AFTER today.
const client = require('./alpacaClient');
const cfg = require('./config');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Alpaca's /v2/options/contracts only supports _gte/_lte suffixes, not _gt (confirmed via
// a live 422 - "request parameters are invalid" - when _gt was tried). Using gte=tomorrow
// is equivalent to "strictly after today" without needing an unsupported operator.
function tomorrowET() {
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  etNow.setDate(etNow.getDate() + 1);
  const y = etNow.getFullYear();
  const m = String(etNow.getMonth() + 1).padStart(2, '0');
  const d = String(etNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Full chain for the nearest expiration that is AFTER today (not >=, unlike the ORB bot -
// see file comment above), sorted by strike ascending.
async function getNearestOvernightChain(symbol, direction) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const res = await client.trading('/v2/options/contracts', {
    params: {
      underlying_symbols: symbol,
      expiration_date_gte: tomorrowET(),
      type,
      status: 'active',
      limit: 1000,
    },
  });
  const all = res.option_contracts || [];
  if (all.length === 0) return [];
  const nearestExpiration = all.reduce(
    (min, c) => (c.expiration_date < min ? c.expiration_date : min),
    all[0].expiration_date
  );
  return all
    .filter((c) => c.expiration_date === nearestExpiration)
    .sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price));
}

// Same "single ATM, else debit spread, else null" logic as the ORB bot's selectStructure,
// just built on the overnight-safe chain above and this strategy's own config/liquidity
// gates. getQuote: async (occSymbol) => { bid, ask, mid } | null.
async function selectStructure(symbol, direction, underlyingPrice, budgetUsd, getQuote) {
  const chain = await getNearestOvernightChain(symbol, direction);
  if (chain.length === 0) return { structure: null, reason: 'no chain past today' };

  let atmIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < chain.length; i++) {
    const diff = Math.abs(parseFloat(chain[i].strike_price) - underlyingPrice);
    if (diff < bestDiff) { bestDiff = diff; atmIdx = i; }
  }
  const atm = chain[atmIdx];

  const check = async (contract) => {
    const oi = parseInt(contract.open_interest, 10) || 0;
    if (oi < cfg.MIN_OPEN_INTEREST) return { ok: false, reason: `OI ${oi} < ${cfg.MIN_OPEN_INTEREST}` };
    const quote = await getQuote(contract.symbol);
    if (!quote || quote.bid <= 0 || quote.ask <= 0) return { ok: false, reason: 'no live quote' };
    const spreadPct = ((quote.ask - quote.bid) / quote.mid) * 100;
    if (spreadPct > cfg.MAX_SPREAD_PCT) return { ok: false, reason: `spread ${spreadPct.toFixed(1)}%` };
    return { ok: true, quote };
  };

  const atmCheck = await check(atm);
  if (!atmCheck.ok) return { structure: null, reason: `ATM ${atm.symbol}: ${atmCheck.reason}` };

  const atmCost = atmCheck.quote.ask * 100;
  if (atmCost <= budgetUsd) {
    return {
      structure: {
        kind: 'single',
        legs: [{ symbol: atm.symbol, side: 'buy' }],
        qty: Math.max(1, Math.floor(budgetUsd / atmCost)),
        quote: atmCheck.quote,
      },
    };
  }

  const isBull = direction === 'bullish';
  const targetStrike = underlyingPrice * (1 + (isBull ? 1 : -1) * cfg.SPREAD_SHORT_STRIKE_OTM_PCT);
  let shortLeg = null;
  let shortDiff = Infinity;
  for (const c of chain) {
    const strike = parseFloat(c.strike_price);
    const beyondAtm = isBull ? strike > parseFloat(atm.strike_price) : strike < parseFloat(atm.strike_price);
    if (!beyondAtm) continue;
    const diff = Math.abs(strike - targetStrike);
    if (diff < shortDiff) { shortDiff = diff; shortLeg = c; }
  }
  if (!shortLeg) return { structure: null, reason: 'no OTM strike for spread short leg' };

  const shortCheck = await check(shortLeg);
  if (!shortCheck.ok) return { structure: null, reason: `short leg ${shortLeg.symbol}: ${shortCheck.reason}` };

  const debit = atmCheck.quote.ask - shortCheck.quote.bid;
  if (debit <= 0) return { structure: null, reason: 'non-positive spread debit' };
  const debitCost = debit * 100;
  if (debitCost > budgetUsd) return { structure: null, reason: `spread debit $${debitCost.toFixed(0)} > budget $${budgetUsd.toFixed(0)}` };

  return {
    structure: {
      kind: 'spread',
      legs: [
        { symbol: atm.symbol, side: 'buy' },
        { symbol: shortLeg.symbol, side: 'sell' },
      ],
      qty: Math.max(1, Math.floor(budgetUsd / debitCost)),
      quote: { long: atmCheck.quote, short: shortCheck.quote },
    },
  };
}

async function getLatestOptionQuote(optionSymbol) {
  const res = await client.data('/v1beta1/options/quotes/latest', { params: { symbols: optionSymbol } });
  const q = res.quotes && res.quotes[optionSymbol];
  if (!q) return null;
  return { bid: q.bp, ask: q.ap, mid: (q.bp + q.ap) / 2 };
}

module.exports = { getNearestOvernightChain, selectStructure, getLatestOptionQuote, todayET };
