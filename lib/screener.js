const fs = require('fs');
const path = require('path');
const client = require('./alpacaClient');
const { atr } = require('./indicators');
const cfg = require('./config');
const watchlist = require('./watchlist');
const contracts = require('./contracts');
const md = require('./marketData');

const OUT_FILE = path.join(__dirname, '..', 'logs', 'daily-universe.json');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function getDailyBars(symbols, days = 50) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await client.data('/v2/stocks/bars', {
    params: { symbols: symbols.join(','), timeframe: '1Day', start, limit: 10000, adjustment: 'split', feed: 'iex' },
  });
  return res.bars || {};
}

function scoreSymbol(bars) {
  if (!bars || bars.length < 21) return null;
  const volumes = bars.map((b) => b.v);
  const last = bars[bars.length - 1];
  const prior20 = volumes.slice(-21, -1);
  const avgVol20 = prior20.reduce((a, b) => a + b, 0) / prior20.length;
  const rvol = avgVol20 > 0 ? last.v / avgVol20 : 0;

  const atrVal = atr(bars.slice(-15), 14);
  const atrPct = atrVal != null ? (atrVal / last.c) * 100 : 0;

  const fiveDaysAgo = bars[bars.length - 6] || bars[0];
  const trendStrengthPct = Math.abs((last.c - fiveDaysAgo.c) / fiveDaysAgo.c) * 100;

  const compositeScore = rvol * 0.4 + atrPct * 0.3 + trendStrengthPct * 0.3;
  return { rvol, atrPct, trendStrengthPct, compositeScore, lastClose: last.c };
}

// Checks not just that a near-term contract exists, but that it's actually tradeable —
// same spread/open-interest bar the entry logic itself enforces. A stock can pass the
// stock-level momentum score yet have options too thin to ever clear the entry filter
// (e.g. GS: real -4.51% day, zero trades possible — 19.5% spread on its ATM contract).
// Checking this at screen time avoids burning a basket slot on a name that can never execute.
async function hasTradeableOptions(symbol, approxPrice) {
  try {
    const contract = await contracts.findNearestContract(symbol, 'bullish', approxPrice);
    if (!contract) return { ok: false, reason: 'no near-term contract' };

    const openInterest = parseInt(contract.open_interest, 10) || 0;
    if (openInterest < cfg.MIN_OPEN_INTEREST) return { ok: false, reason: `OI ${openInterest} < ${cfg.MIN_OPEN_INTEREST}` };

    const quote = await md.getLatestOptionQuote(contract.symbol);
    if (!quote || quote.bid <= 0 || quote.ask <= 0) return { ok: false, reason: 'no live quote' };

    const spreadPct = ((quote.ask - quote.bid) / quote.mid) * 100;
    if (spreadPct > cfg.MAX_SPREAD_PCT) return { ok: false, reason: `spread ${spreadPct.toFixed(1)}% > ${cfg.MAX_SPREAD_PCT}%` };

    if (cfg.SMALL_ACCOUNT_MODE) {
      const contractCost = quote.ask * 100;
      if (contractCost > cfg.SMALL_ACCOUNT_MAX_TRADE_USD) {
        return { ok: false, reason: `contract cost $${contractCost.toFixed(0)} > $${cfg.SMALL_ACCOUNT_MAX_TRADE_USD} live cap` };
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function runScreen({ verbose = false } = {}) {
  const bars = await getDailyBars(watchlist);

  const scored = [];
  for (const symbol of watchlist) {
    const s = scoreSymbol(bars[symbol]);
    if (s) scored.push({ symbol, ...s });
  }
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  if (verbose) {
    console.log('Top 15 by composite score:');
    console.table(
      scored.slice(0, 15).map((s) => ({
        symbol: s.symbol,
        rvol: s.rvol.toFixed(2),
        atrPct: s.atrPct.toFixed(2),
        trend5d: s.trendStrengthPct.toFixed(2),
        score: s.compositeScore.toFixed(2),
      }))
    );
  }

  const selected = [];
  for (const candidate of scored) {
    if (selected.length >= cfg.DAILY_UNIVERSE_SIZE) break;
    const result = await hasTradeableOptions(candidate.symbol, candidate.lastClose);
    if (result.ok) selected.push(candidate.symbol);
    else if (verbose) console.log(`Skipping ${candidate.symbol} — ${result.reason}`);
  }

  const today = todayET();
  const output = { date: today, symbols: selected, scoredAt: new Date().toISOString() };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  return output;
}

function getTodaysUniverse() {
  if (!fs.existsSync(OUT_FILE)) return null;
  const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  if (data.date !== todayET()) return null;
  if (!data.symbols || data.symbols.length === 0) return null;
  return data;
}

module.exports = { runScreen, getTodaysUniverse, scoreSymbolForTest: scoreSymbol };
