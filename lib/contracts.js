const client = require('./alpacaClient');
const cfg = require('./config');

function todayET() {
  // en-CA gives YYYY-MM-DD format
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// direction: 'bullish' -> call, 'bearish' -> put
// Finds the ATM contract at the NEAREST available expiration on or after today.
// For SPY/QQQ/IWM this is same-day (true 0DTE) every trading day; for most individual
// stocks it's same-day only on their weekly (usually Friday) expiration, and the nearest
// upcoming expiration (days out) the rest of the week.
async function findNearestContract(symbol, direction, underlyingPrice) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const today = todayET();

  const res = await client.trading('/v2/options/contracts', {
    params: {
      underlying_symbols: symbol,
      expiration_date_gte: today,
      type,
      status: 'active',
      limit: 1000,
    },
  });

  const contracts = res.option_contracts || [];
  if (contracts.length === 0) return null;

  const nearestExpiration = contracts.reduce(
    (min, c) => (c.expiration_date < min ? c.expiration_date : min),
    contracts[0].expiration_date
  );
  const nearestContracts = contracts.filter((c) => c.expiration_date === nearestExpiration);

  let best = null;
  let bestDiff = Infinity;
  for (const c of nearestContracts) {
    const diff = Math.abs(parseFloat(c.strike_price) - underlyingPrice);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

// Full nearest-expiration chain (one side), sorted by strike ascending.
async function getNearestChain(symbol, direction) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const res = await client.trading('/v2/options/contracts', {
    params: {
      underlying_symbols: symbol,
      expiration_date_gte: todayET(),
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

// Picks a tradeable option structure for an ORB entry that fits the premium budget:
//   1. single long ATM contract if its cost fits (qty scaled into the budget)
//   2. otherwise a vertical debit spread: long ATM, short ~SPREAD_SHORT_STRIKE_OTM_PCT OTM
//   3. otherwise null (symbol unaffordable today)
// getQuote: async (occSymbol) => { bid, ask, mid } | null — injected to avoid a require cycle.
// Every returned leg has passed the spread% and open-interest liquidity gates.
async function selectStructure(symbol, direction, underlyingPrice, budgetUsd, getQuote) {
  const chain = await getNearestChain(symbol, direction);
  if (chain.length === 0) return { structure: null, reason: 'no near-term chain' };

  let atmIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < chain.length; i++) {
    const diff = Math.abs(parseFloat(chain[i].strike_price) - underlyingPrice);
    if (diff < bestDiff) {
      bestDiff = diff;
      atmIdx = i;
    }
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
        limitPrice: null, // filled in by caller from live quote
        quote: atmCheck.quote,
      },
    };
  }

  // Debit spread: short strike ~OTM_PCT beyond spot in the trade direction.
  const isBull = direction === 'bullish';
  const targetStrike = underlyingPrice * (1 + (isBull ? 1 : -1) * cfg.SPREAD_SHORT_STRIKE_OTM_PCT);
  let shortLeg = null;
  let shortDiff = Infinity;
  for (const c of chain) {
    const strike = parseFloat(c.strike_price);
    const beyondAtm = isBull ? strike > parseFloat(atm.strike_price) : strike < parseFloat(atm.strike_price);
    if (!beyondAtm) continue;
    const diff = Math.abs(strike - targetStrike);
    if (diff < shortDiff) {
      shortDiff = diff;
      shortLeg = c;
    }
  }
  if (!shortLeg) return { structure: null, reason: 'no OTM strike for spread short leg' };

  const shortCheck = await check(shortLeg);
  if (!shortCheck.ok) return { structure: null, reason: `short leg ${shortLeg.symbol}: ${shortCheck.reason}` };

  // conservative debit estimate: pay the ask on the long, receive the bid on the short
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
      limitPrice: null,
      quote: { long: atmCheck.quote, short: shortCheck.quote },
    },
  };
}

// OCC symbol format: <root><YYMMDD><C|P><strike*1000, 8 digits> — last 15 chars are
// always date+type+strike; everything before that is the (variable-length) root symbol.
function parseOccSymbol(occSymbol) {
  const suffix = occSymbol.slice(-15);
  const yymmdd = suffix.slice(0, 6);
  const type = suffix.slice(6, 7);
  const strike = parseInt(suffix.slice(7), 10) / 1000;
  const expirationDate = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return { root: occSymbol.slice(0, -15), expirationDate, type: type === 'C' ? 'call' : 'put', strike };
}

function isZeroDTE(occSymbol) {
  return parseOccSymbol(occSymbol).expirationDate === todayET();
}

module.exports = { findNearestContract, getNearestChain, selectStructure, todayET, parseOccSymbol, isZeroDTE };
