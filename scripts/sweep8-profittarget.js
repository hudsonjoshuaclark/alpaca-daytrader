// Tests whether adding an early profit-target exit to ORB-15 helps or hurts, given
// lib/config.js's existing explicit design choice: "No profit target — winners run to
// end of day." sweep5-options.js already found the real-option return distribution is
// fat-tailed, driven by rare huge winners (e.g. a real SPY put at +1196%). This checks
// directly whether capping winners early at various profit-target levels (including the
// user-requested 220% = 4x the current 55% OPTION_STOP_PCT) helps or hurts expectancy,
// using the same real-historical-option-contract-resolution technique as sweep5/7.
//
// Usage: node --env-file=.env scripts/sweep8-profittarget.js [days]
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

function summarize(label, rs) {
  const n = rs.length;
  if (!n) { console.log(`${label}: none`); return; }
  const tot = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  console.log(
    `${label}: n=${n} winRate=${((wins.length / n) * 100).toFixed(1)}% exp=${((tot / n) * 10000).toFixed(2)}bp ` +
    `avgWin=${((wins.reduce((a, b) => a + b, 0) / (wins.length || 1)) * 100).toFixed(3)}% ` +
    `avgLoss=${((rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / ((n - wins.length) || 1)) * 100).toFixed(3)}% tot=${(tot * 100).toFixed(2)}%`
  );
}

// Same exit priority as runner.js's manageOpenTrades: custom stop/target checked before
// option_stop, then or_mid_stop, then EOD - profitTargetPct=null means no target (baseline).
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
      const best = bar.h;
      const plPct = (best - entryPremium) / entryPremium;
      if (plPct >= profitTargetPct) return { r: profitTargetPct, exit: 'profit_target' };
    }

    if (optionStopPct != null) {
      const worst = bar.l;
      const plPct = (worst - entryPremium) / entryPremium;
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
  console.log(`Found ${signals.length} real ORB signals. Resolving option contracts (this makes ~5-10 API calls per signal)...\n`);

  const resolved = [];
  let unresolved = 0;
  for (const sig of signals) {
    const contract = await findHistoricalContract(sig.symbol, sig.day, sig.isBull ? 'bullish' : 'bearish', sig.price);
    if (!contract) { unresolved++; continue; }
    const optParts = contract.bars.map(etParts);
    resolved.push({ ...sig, optionBars: contract.bars, optParts, occSymbol: contract.occ });
  }
  console.log(`Resolved ${resolved.length}/${signals.length} signals to real option contracts (${unresolved} unresolved).\n`);

  const stopPct = cfg.OPTION_STOP_PCT; // 0.55 - unchanged, only testing the target side
  for (const profitTargetPct of [null, 1.10, 1.65, 2.20, 3.30]) {
    const results = [];
    const exitCounts = { option_stop: 0, or_mid_stop: 0, eod: 0, profit_target: 0 };
    for (const r of resolved) {
      const sim = simulateExit(r.optionBars, r.optParts, r.bars, r.parts, r.entryTime, r.day, r.orMid, r.isBull, stopPct, profitTargetPct);
      if (!sim) continue;
      results.push(sim.r);
      exitCounts[sim.exit]++;
    }
    const label = profitTargetPct == null ? 'NO TARGET (current baseline)' : `target=${(profitTargetPct * 100).toFixed(0)}%${profitTargetPct === 2.20 ? ' <- requested 4:1 ratio' : ''}`;
    summarize(label, results);
    console.log(`  exit reasons:`, exitCounts);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
