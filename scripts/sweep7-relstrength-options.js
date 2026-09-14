// Options-level validation of the relative-strength-vs-SPY filter that sweep6-filters.js
// found promising at the underlying level (apples-to-apples: 16.38bp unfiltered -> 18.89bp
// filtered on the same non-SPY/QQQ pool, n=307 kept / 17 removed). Underlying-level results
// don't necessarily hold at the options level for this bot — sweep5-options.js already
// showed the real-option return distribution is fat-tailed/leverage-amplified in a way the
// underlying never was. Same real-historical-option-contract-resolution machinery as
// sweep5-options.js (see that file for the two bugs found and fixed in the harness itself).
// SPY/QQQ signals are exempt from the relative-strength filter (they ARE the benchmark) —
// this script keeps that same exemption for the "with filter" arm.
//
// Usage: node --env-file=.env scripts/sweep7-relstrength-options.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30';
const ZERO_DTE_SYMBOLS = new Set(['SPY', 'QQQ']);
const INDEX_SYMBOL = 'SPY';

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

function occDate(dayStr) {
  return dayStr.slice(2).replace(/-/g, '');
}

function buildOccSymbol(root, expDate, type, strike) {
  const strikeInt = Math.round(strike * 1000);
  return `${root}${occDate(expDate)}${type === 'call' ? 'C' : 'P'}${String(strikeInt).padStart(8, '0')}`;
}

async function findHistoricalContract(symbol, day, direction, underlyingPrice) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const expDate = ZERO_DTE_SYMBOLS.has(symbol) ? day : nextFridayOnOrAfter(day);
  const dayStart = `${day}T00:00:00Z`;
  const dayEnd = `${day}T23:59:59Z`;

  const increments = underlyingPrice < 50 ? [1, 2.5, 0.5]
    : underlyingPrice < 300 ? [2.5, 5, 1]
    : [5, 2.5, 10];

  const candidates = new Set();
  for (const inc of increments) {
    const base = Math.round(underlyingPrice / inc) * inc;
    for (const off of [0, -1, 1, -2, 2]) {
      candidates.add(+(base + off * inc).toFixed(2));
    }
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

function simulateExit(optionBars, optBarParts, underlyingBars, underlyingParts, entryTime, day, orMid, isBull, optionStopPct) {
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
  const days = parseInt(process.argv[2] || '45', 10);
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

  const spy = data.find((d) => d.symbol === INDEX_SYMBOL);
  const spyPctByDayTime = new Map();
  for (const [day, { firstIdx, lastIdx }] of spy.dayIndex) {
    const open = spy.bars[firstIdx].o;
    for (let i = firstIdx; i <= lastIdx; i++) {
      spyPctByDayTime.set(`${day}|${spy.parts[i].time}`, (spy.bars[i].c - open) / open);
    }
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
      const symbolOpen = bars[firstIdx].o;
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

        const symPct = (c - symbolOpen) / symbolOpen;
        const spyPct = spyPctByDayTime.get(`${day}|${parts[i].time}`);
        const relStrengthOk = symbol === 'SPY' || symbol === 'QQQ' || spyPct == null
          ? null
          : (isBull ? symPct > spyPct : symPct < spyPct);

        signals.push({ symbol, day, isBull, orMid, price: c, entryTime: parts[i].time, bars, parts, relStrengthOk });
        break;
      }
    }
  }
  console.log(`Found ${signals.length} real ORB signals. Resolving option contracts...\n`);

  const resolved = [];
  let unresolved = 0;
  for (const sig of signals) {
    const contract = await findHistoricalContract(sig.symbol, sig.day, sig.isBull ? 'bullish' : 'bearish', sig.price);
    if (!contract) { unresolved++; continue; }
    const optParts = contract.bars.map(etParts);
    resolved.push({ ...sig, optionBars: contract.bars, optParts, occSymbol: contract.occ });
  }
  console.log(`Resolved ${resolved.length}/${signals.length} signals to real option contracts (${unresolved} unresolved).\n`);

  const results = [];
  for (const r of resolved) {
    const sim = simulateExit(r.optionBars, r.optParts, r.bars, r.parts, r.entryTime, r.day, r.orMid, r.isBull, cfg.OPTION_STOP_PCT);
    if (!sim) continue;
    results.push({ symbol: r.symbol, day: r.day, r: sim.r, exit: sim.exit, relStrengthOk: r.relStrengthOk });
  }

  console.log('=== Options-level: baseline (all resolved trades) ===');
  summarize('baseline', results.map((t) => t.r));

  const eligible = results.filter((t) => t.relStrengthOk != null);
  console.log('\n=== Options-level: relative-strength-eligible pool (non-SPY/QQQ), unfiltered ===');
  summarize('unfiltered (apples-to-apples baseline)', eligible.map((t) => t.r));

  console.log('\n=== Options-level: WITH relative-strength filter applied ===');
  summarize('in-favor only (kept)', eligible.filter((t) => t.relStrengthOk).map((t) => t.r));
  summarize('against (would be excluded)', eligible.filter((t) => !t.relStrengthOk).map((t) => t.r));

  console.log(`\nSPY/QQQ (exempt, always included) n=${results.filter((t) => t.relStrengthOk == null).length}`);
  summarize('  SPY/QQQ only', results.filter((t) => t.relStrengthOk == null).map((t) => t.r));
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
