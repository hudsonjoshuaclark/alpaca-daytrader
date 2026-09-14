// Full grid search over (OPTION_STOP_PCT x PROFIT_TARGET_PCT) to find the best-performing
// combination, not just profit-target levels at a fixed 55% stop (sweep8). Resolves real
// option contracts ONCE, then simulates every (stop, target) pair cheaply in-memory against
// the same resolved bars - the expensive part (contract resolution) only happens once.
//
// sweep8-profittarget.js already found every tested target level UNDERPERFORMS no target
// at all at the current 55% stop. This checks whether a different stop level changes that
// conclusion, and reports the actual best combination found - explicitly checking for
// overfitting (a lone spike vs. a plateau of nearby-similar performers) before calling
// anything "best."
//
// Usage: node --env-file=.env scripts/sweep9-stoptarget-grid.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30';
const ZERO_DTE_SYMBOLS = new Set(['SPY', 'QQQ']);

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

function nextFridayOnOrAfter(dayStr) {
  const d = new Date(`${dayStr}T12:00:00Z`);
  const dow = d.getUTCDay();
  const add = (5 - dow + 7) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

function occDate(dayStr) { return dayStr.slice(2).replace(/-/g, ''); }
function buildOccSymbol(root, expDate, type, strike) {
  const strikeInt = Math.round(strike * 1000);
  return `${root}${occDate(expDate)}${type === 'call' ? 'C' : 'P'}${String(strikeInt).padStart(8, '0')}`;
}

async function findHistoricalContract(symbol, day, direction, underlyingPrice) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const expDate = ZERO_DTE_SYMBOLS.has(symbol) ? day : nextFridayOnOrAfter(day);
  const dayStart = `${day}T00:00:00Z`;
  const dayEnd = `${day}T23:59:59Z`;
  const increments = underlyingPrice < 50 ? [1, 2.5, 0.5] : underlyingPrice < 300 ? [2.5, 5, 1] : [5, 2.5, 10];
  const candidates = new Set();
  for (const inc of increments) {
    const base = Math.round(underlyingPrice / inc) * inc;
    for (const off of [0, -1, 1, -2, 2]) candidates.add(+(base + off * inc).toFixed(2));
  }
  let best = null;
  for (const strike of candidates) {
    if (strike <= 0) continue;
    const occ = buildOccSymbol(symbol, expDate, type, strike);
    const bars = await getOptionBars(occ, dayStart, dayEnd);
    if (bars.length === 0) continue;
    const diff = Math.abs(strike - underlyingPrice);
    if (!best || diff < best.diff) best = { occ, strike, diff, bars, expDate };
  }
  return best;
}

function summarize(rs) {
  const n = rs.length;
  if (!n) return { n: 0, exp: null, winRate: null };
  const tot = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  return {
    n,
    exp: (tot / n) * 10000,
    winRate: (wins.length / n) * 100,
    avgWin: (wins.reduce((a, b) => a + b, 0) / (wins.length || 1)) * 100,
    avgLoss: (rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / ((n - wins.length) || 1)) * 100,
  };
}

function simulateExit(optionBars, optBarParts, underlyingBars, underlyingParts, entryTime, day, orMid, isBull, optionStopPct, profitTargetPct) {
  let entryIdx = -1;
  for (let j = 0; j < optionBars.length; j++) {
    if (optBarParts[j].day === day && optBarParts[j].time >= entryTime) { entryIdx = j; break; }
  }
  if (entryIdx < 0) return null;
  const entryPremium = optionBars[entryIdx].o;
  if (!entryPremium || entryPremium <= 0) return null;

  const uByTime = new Map();
  for (let i = 0; i < underlyingBars.length; i++) {
    if (underlyingParts[i].day === day) uByTime.set(underlyingParts[i].time, underlyingBars[i]);
  }

  let lastPremium = entryPremium;
  for (let j = entryIdx; j < optionBars.length; j++) {
    const p = optBarParts[j];
    if (p.day !== day) continue;
    if (p.time >= '15:45') break;
    const bar = optionBars[j];
    lastPremium = bar.c;
    if (j === entryIdx) continue;

    if (profitTargetPct != null) {
      const plPct = (bar.h - entryPremium) / entryPremium;
      if (plPct >= profitTargetPct) return { r: profitTargetPct, exit: 'profit_target' };
    }
    if (optionStopPct != null) {
      const plPct = (bar.l - entryPremium) / entryPremium;
      if (plPct <= -optionStopPct) return { r: -optionStopPct, exit: 'option_stop' };
    }
    const uBar = uByTime.get(p.time);
    if (uBar) {
      const crossed = isBull ? uBar.l <= orMid : uBar.h >= orMid;
      if (crossed) return { r: (lastPremium - entryPremium) / entryPremium, exit: 'or_mid_stop' };
    }
  }
  return { r: (lastPremium - entryPremium) / entryPremium, exit: 'eod' };
}

async function main() {
  const days = parseInt(process.argv[2] || '90', 10);
  console.log(`Fetching ${days} days of underlying 5-min bars for ${SYMBOLS.length} symbols...`);
  const data = [];
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const parts = bars.map(etParts);
    const dayIndex = new Map();
    for (let i = 0; i < bars.length; i++) {
      const d = parts[i].day;
      if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i });
      else dayIndex.get(d).lastIdx = i;
    }
    data.push({ symbol, bars, parts, dayIndex });
  }

  const signals = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const orBarCount = OR_MINUTES / 5;
      if (lastIdx - firstIdx < orBarCount + 2) continue;
      let orHigh = -Infinity, orLow = Infinity, orEnd = -1, seen = 0;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:30') continue;
        orHigh = Math.max(orHigh, bars[i].h);
        orLow = Math.min(orLow, bars[i].l);
        seen++;
        if (seen === orBarCount) { orEnd = i; break; }
      }
      if (orEnd < 0) continue;
      const orMid = (orHigh + orLow) / 2;
      for (let i = orEnd + 1; i <= lastIdx; i++) {
        if (parts[i].time >= CUTOFF) break;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        const rvol = bars[i].v / avgVol[i];
        if (rvol < RVOL_MIN) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true;
        else if (c < orLow) isBull = false;
        if (isBull === null) continue;
        signals.push({ symbol, day, isBull, orMid, price: c, entryTime: parts[i].time, bars, parts });
        break;
      }
    }
  }
  console.log(`Found ${signals.length} real ORB signals. Resolving option contracts ONCE (this makes ~5-10 API calls per signal, then every grid combo below is free)...\n`);

  const resolved = [];
  for (const sig of signals) {
    const contract = await findHistoricalContract(sig.symbol, sig.day, sig.isBull ? 'bullish' : 'bearish', sig.price);
    if (!contract) continue;
    const optParts = contract.bars.map(etParts);
    resolved.push({ ...sig, optionBars: contract.bars, optParts, occSymbol: contract.occ });
  }
  console.log(`Resolved ${resolved.length}/${signals.length} signals.\n`);

  const stopGrid = [0.35, 0.45, 0.55, 0.70, 0.85, null];
  const targetGrid = [null, 1.10, 1.65, 2.20, 3.30, 5.00, 8.00];

  const grid = [];
  for (const stopPct of stopGrid) {
    for (const targetPct of targetGrid) {
      const results = [];
      for (const r of resolved) {
        const sim = simulateExit(r.optionBars, r.optParts, r.bars, r.parts, r.entryTime, r.day, r.orMid, r.isBull, stopPct, targetPct);
        if (sim) results.push(sim.r);
      }
      const s = summarize(results);
      grid.push({ stopPct, targetPct, ...s, monthly: results });
    }
  }

  console.log('=== Full grid, sorted by expectancy (best first) ===');
  const sorted = [...grid].sort((a, b) => (b.exp ?? -Infinity) - (a.exp ?? -Infinity));
  for (const g of sorted) {
    const ratio = g.targetPct == null ? 'uncapped' : (g.stopPct == null ? 'n/a (no stop)' : (g.targetPct / g.stopPct).toFixed(2) + ':1');
    console.log(
      `stop=${g.stopPct == null ? 'none' : (g.stopPct * 100).toFixed(0) + '%'} ` +
      `target=${g.targetPct == null ? 'none' : (g.targetPct * 100).toFixed(0) + '%'} ` +
      `ratio=${ratio} n=${g.n} exp=${g.exp?.toFixed(1)}bp winRate=${g.winRate?.toFixed(1)}% avgWin=${g.avgWin?.toFixed(1)}% avgLoss=${g.avgLoss?.toFixed(1)}%`
    );
  }

  console.log('\n=== Top 5 - monthly stability check (is it a plateau or a lone spike?) ===');
  for (const g of sorted.slice(0, 5)) {
    const byMonth = {};
    for (const r of resolved) {
      const sim = simulateExit(r.optionBars, r.optParts, r.bars, r.parts, r.entryTime, r.day, r.orMid, r.isBull, g.stopPct, g.targetPct);
      if (!sim) continue;
      const m = r.day.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(sim.r);
    }
    console.log(`\nstop=${g.stopPct == null ? 'none' : (g.stopPct * 100).toFixed(0) + '%'} target=${g.targetPct == null ? 'none' : (g.targetPct * 100).toFixed(0) + '%'}:`);
    for (const m of Object.keys(byMonth).sort()) {
      const s = summarize(byMonth[m]);
      console.log(`  ${m}: n=${s.n} exp=${s.exp?.toFixed(1)}bp`);
    }
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
