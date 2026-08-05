// Live 0DTE put contract selection for SPY/QQQ - finds today's expiration chain (exact
// match, not "nearest on or after" like the other bots, since this strategy specifically
// needs same-day expiration) and picks a short strike near cfg.SHORT_OTM_PCT OTM plus a
// protective long strike cfg.WIDTH further out.
const client = require('./alpacaClient');
const cfg = require('./config');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function getTodayPutChain(symbol) {
  const today = todayET();
  const res = await client.trading('/v2/options/contracts', {
    params: {
      underlying_symbols: symbol,
      expiration_date: today,
      type: 'put',
      status: 'active',
      limit: 1000,
    },
  });
  return (res.option_contracts || []).sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price));
}

async function getLatestOptionQuote(optionSymbol) {
  const res = await client.data('/v1beta1/options/quotes/latest', { params: { symbols: optionSymbol } });
  const q = res.quotes && res.quotes[optionSymbol];
  if (!q) return null;
  return { bid: q.bp, ask: q.ap, mid: (q.bp + q.ap) / 2 };
}

function closestByStrike(chain, targetStrike) {
  let best = null, bestDiff = Infinity;
  for (const c of chain) {
    const diff = Math.abs(parseFloat(c.strike_price) - targetStrike);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best;
}

// Returns { structure, reason } - structure has { shortLeg, longLeg, netCredit, maxRisk }
// or null with a reason if liquidity/today's-chain checks fail.
async function selectCreditSpread(symbol, underlyingPrice) {
  const chain = await getTodayPutChain(symbol);
  if (chain.length === 0) return { structure: null, reason: 'no 0DTE put chain today' };

  const shortTarget = underlyingPrice * (1 - cfg.SHORT_OTM_PCT);
  const shortContract = closestByStrike(chain, shortTarget);
  if (!shortContract) return { structure: null, reason: 'no short strike candidate' };

  const longTarget = parseFloat(shortContract.strike_price) - cfg.WIDTH;
  const longCandidates = chain.filter((c) => parseFloat(c.strike_price) < parseFloat(shortContract.strike_price));
  const longContract = closestByStrike(longCandidates, longTarget);
  if (!longContract) return { structure: null, reason: 'no long (protective) strike candidate' };

  const actualWidth = parseFloat(shortContract.strike_price) - parseFloat(longContract.strike_price);
  if (actualWidth <= 0) return { structure: null, reason: 'resolved strikes give non-positive width' };

  const check = async (contract) => {
    const oi = parseInt(contract.open_interest, 10) || 0;
    if (oi < cfg.MIN_OPEN_INTEREST) return { ok: false, reason: `OI ${oi} < ${cfg.MIN_OPEN_INTEREST}` };
    const quote = await getLatestOptionQuote(contract.symbol);
    if (!quote || quote.bid <= 0 || quote.ask <= 0) return { ok: false, reason: 'no live quote' };
    const spreadPct = ((quote.ask - quote.bid) / quote.mid) * 100;
    if (spreadPct > cfg.MAX_SPREAD_PCT) return { ok: false, reason: `spread ${spreadPct.toFixed(1)}%` };
    return { ok: true, quote };
  };

  const shortCheck = await check(shortContract);
  if (!shortCheck.ok) return { structure: null, reason: `short leg ${shortContract.symbol}: ${shortCheck.reason}` };
  const longCheck = await check(longContract);
  if (!longCheck.ok) return { structure: null, reason: `long leg ${longContract.symbol}: ${longCheck.reason}` };

  // Conservative executable credit: receive the short's bid, pay the long's ask.
  const netCredit = shortCheck.quote.bid - longCheck.quote.ask;
  if (netCredit <= 0) return { structure: null, reason: 'non-positive net credit at conservative fill prices' };

  const maxRisk = actualWidth - netCredit;
  if (maxRisk <= 0) return { structure: null, reason: 'non-positive max risk (width <= credit, unusual)' };

  return {
    structure: {
      shortLeg: { symbol: shortContract.symbol, side: 'sell', strike: parseFloat(shortContract.strike_price) },
      longLeg: { symbol: longContract.symbol, side: 'buy', strike: parseFloat(longContract.strike_price) },
      netCredit,
      maxRisk,
      actualWidth,
    },
  };
}

module.exports = { getTodayPutChain, getLatestOptionQuote, selectCreditSpread, todayET };
