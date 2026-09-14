// Candidate strategy #3: 0DTE put credit spread premium selling on SPY/QQQ. Fundamentally
// different MECHANISM from ORB-15 (selling theta/volatility, defined-risk, vs buying
// directional gamma). Research (2026-07-28 survey): 0DTE iron condors/credit spreads
// report 63-94% win rates when held to expiration; SPY is 88% of all 0DTE volume.
// Simplified to the put side only (index-drift tailwind) rather than a full iron condor,
// and to a narrow dollar-width spread (not a %-of-price width) - SPY/QQQ trade at a level
// where even a 1% OTM-to-OTM width is many hundreds of dollars of max risk, too big for
// this account's sizing. Uses REAL historical option premium bars for BOTH legs (same
// contract-resolution technique as sweep5/7-options.js), not a theoretical payoff formula.
//
// Usage: node --env-file=.env scripts/strategy-creditspread-sweep.js [days]
const client = require('../lib/alpacaClient');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ'];
const WIDTH = process.env.CS_WIDTH ? parseFloat(process.env.CS_WIDTH) : 3; // $ between short and long put strikes
const SHORT_OTM_PCT = process.env.CS_OTM ? parseFloat(process.env.CS_OTM) : 0.01; // short put target distance OTM
const PROFIT_TARGET_PCT = 0.5; // close at 50% of max credit captured
const STOP_MULTIPLE = 2.0; // close if spread value grows to 2x credit received (loss)

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let allBars = [];
  let pageToken = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: {
        symbols: symbol, timeframe: cfg.TIMEFRAME, start, limit: 10000,
        adjustment: 'split', feed: 'iex', page_token: pageToken || undefined,
      },
    });
    allBars = allBars.concat(res.bars[symbol] || []);
    pageToken = res.next_page_token;
  } while (pageToken);
  return allBars;
}

async function getOptionBars(occSymbol, dayStart, dayEnd) {
  try {
    const res = await client.data('/v1beta1/options/bars', {
      params: { symbols: occSymbol, timeframe: '5Min', start: dayStart, end: dayEnd, limit: 500 },
    });
    return (res.bars && res.bars[occSymbol]) || [];
  } catch (e) {
    return [];
  }
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

function occDate(dayStr) { return dayStr.slice(2).replace(/-/g, ''); }
function buildOccSymbol(root, expDate, strike) {
  const strikeInt = Math.round(strike * 1000);
  return `${root}${occDate(expDate)}P${String(strikeInt).padStart(8, '0')}`;
}

// Finds real historical put contracts near a target strike (same-day 0DTE expiration),
// trying nearby strike increments until one with real bar data is found.
async function findPutNear(symbol, day, targetStrike, priceForIncrement) {
  const dayStart = `${day}T00:00:00Z`;
  const dayEnd = `${day}T23:59:59Z`;
  const increments = priceForIncrement < 300 ? [1, 0.5, 2.5] : [1, 5, 2.5];
  const candidates = new Set();
  for (const inc of increments) {
    const base = Math.round(targetStrike / inc) * inc;
    for (const off of [0, -1, 1, -2, 2, -3, 3]) candidates.add(+(base + off * inc).toFixed(2));
  }
  let best = null;
  for (const strike of candidates) {
    if (strike <= 0) continue;
    const occ = buildOccSymbol(symbol, day, strike);
    const bars = await getOptionBars(occ, dayStart, dayEnd);
    if (bars.length === 0) continue;
    const diff = Math.abs(strike - targetStrike);
    if (!best || diff < best.diff) best = { occ, strike, diff, bars };
  }
  return best;
}

function summarize(label, rs) {
  const n = rs.length;
  if (!n) { console.log(`${label}: none`); return; }
  const tot = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  console.log(
    `${label}: n=${n} winRate=${((wins.length / n) * 100).toFixed(1)}% exp=${((tot / n) * 10000).toFixed(2)}bp (of max risk) ` +
    `avgWin=${((wins.reduce((a, b) => a + b, 0) / (wins.length || 1)) * 100).toFixed(3)}% ` +
    `avgLoss=${((rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / ((n - wins.length) || 1)) * 100).toFixed(3)}% tot=${(tot * 100).toFixed(2)}%`
  );
}

async function main() {
  const days = parseInt(process.argv[2] || '60', 10);
  console.log(`Fetching ${days} days of underlying bars for ${SYMBOLS.join(',')} (width=$${WIDTH}, shortOtm=${SHORT_OTM_PCT * 100}%)...`);

  const results = [];
  let unresolved = 0;
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const parts = bars.map(etParts);
    const dayIndex = new Map();
    for (let i = 0; i < bars.length; i++) {
      const d = parts[i].day;
      if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i });
      else dayIndex.get(d).lastIdx = i;
    }
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const openPrice = bars[firstIdx].o;
      const shortTarget = openPrice * (1 - SHORT_OTM_PCT);
      const longTarget = shortTarget - WIDTH;

      const shortC = await findPutNear(symbol, day, shortTarget, openPrice);
      const longC = await findPutNear(symbol, day, longTarget, openPrice);
      if (!shortC || !longC || shortC.strike === longC.strike) { unresolved++; continue; }

      const actualWidth = shortC.strike - longC.strike;
      if (actualWidth <= 0) { unresolved++; continue; }

      const shortParts = shortC.bars.map(etParts);
      const longParts = longC.bars.map(etParts);
      // align by time-of-day
      const longByTime = new Map();
      for (let i = 0; i < longC.bars.length; i++) longByTime.set(longParts[i].time, longC.bars[i]);

      // entry: first bar of the day for both legs
      const shortEntry = shortC.bars[0].o;
      const longEntryBar = longByTime.get(shortParts[0].time) || longC.bars[0];
      const longEntry = longEntryBar.o;
      const netCredit = shortEntry - longEntry;
      if (netCredit <= 0) { unresolved++; continue; } // sanity: credit spread must collect a credit

      const maxRisk = actualWidth - netCredit;
      if (maxRisk <= 0) { unresolved++; continue; }

      let exitR = null, exitReason = 'eod';
      for (let i = 1; i < shortC.bars.length; i++) {
        if (shortParts[i].time >= '15:55') break;
        const longBar = longByTime.get(shortParts[i].time);
        if (!longBar) continue;
        // cost to close now = buy back short (pay its current price) - sell long (receive its current price)
        const closeCost = shortC.bars[i].c - longBar.c;
        const pnl = netCredit - closeCost;
        if (pnl >= netCredit * PROFIT_TARGET_PCT) { exitR = pnl / maxRisk; exitReason = 'profit_target'; break; }
        if (pnl <= -netCredit * (STOP_MULTIPLE - 1)) { exitR = pnl / maxRisk; exitReason = 'stop'; break; }
      }
      if (exitR == null) {
        const lastShort = shortC.bars[shortC.bars.length - 1].c;
        const lastLongBar = longByTime.get(shortParts[shortParts.length - 1].time);
        const lastLong = lastLongBar ? lastLongBar.c : longC.bars[longC.bars.length - 1].c;
        const closeCost = lastShort - lastLong;
        exitR = (netCredit - closeCost) / maxRisk;
      }
      results.push({ symbol, day, r: exitR, exit: exitReason, netCredit, maxRisk, actualWidth });
    }
  }

  console.log(`\nResolved ${results.length} day-legs (${unresolved} unresolved/skipped).\n`);
  summarize('baseline (all)', results.map((t) => t.r));
  console.log('\nPer-symbol:');
  for (const s of SYMBOLS) summarize(s.padEnd(5), results.filter((t) => t.symbol === s).map((t) => t.r));
  console.log('\nExit reasons:', results.reduce((a, t) => { a[t.exit] = (a[t.exit] || 0) + 1; return a; }, {}));
  console.log('\nPer-month:');
  const months = [...new Set(results.map((t) => t.day.slice(0, 7)))].sort();
  for (const m of months) summarize(m, results.filter((t) => t.day.slice(0, 7) === m).map((t) => t.r));
  console.log('\nWorst 5 (tail risk check):');
  for (const t of [...results].sort((a, b) => a.r - b.r).slice(0, 5)) {
    console.log(`  ${t.symbol} ${t.day} r=${(t.r * 100).toFixed(1)}% exit=${t.exit} credit=${t.netCredit.toFixed(2)} maxRisk=${t.maxRisk.toFixed(2)} width=${t.actualWidth}`);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
