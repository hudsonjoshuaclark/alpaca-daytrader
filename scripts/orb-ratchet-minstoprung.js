// Does ORB-15's ratchet trail belong armed from rung 1?
//
// WHY THIS EXISTS (2026-08-30). lib/config.js documents an explicit safety contract for the
// ratchet, written when step and trail were both 0.15:
//
//     "The rung-0 stop is deliberately NOT used (minStopRung: 1 in runner.js). A trade that
//      never runs is still governed only by the existing, backtested or_mid_stop and
//      OPTION_STOP_PCT exits - this must not quietly introduce a tighter entry-side stop
//      than what was validated."
//
// That contract held ONLY because step == trail put rung 1's stop exactly at breakeven, so
// the trail could never fire at a loss. On 2026-08-04 the step was cut 0.15 -> 0.02 and the
// trail left at 0.15. rung 1 now arms at +2% of premium and sets its stop at -13%, so the
// ratchet DOES now introduce an entry-side stop tighter than what was validated - the exact
// thing the comment forbids - and +2% on a contract MAX_SPREAD_PCT permits to be 8% wide is
// inside the quote noise band. Live evidence, logs/trade-log.jsonl: 24 of 38 trail_stop
// exits are losses totalling -$660, armed at rungs 1-8, with logged rung-1 advances firing
// at gains of 2.3-3.3%.
//
// The question this answers is NOT "is the ratchet good" (orb-ratchet-research.js settled
// that: it is). It is the narrower one that regression opened: given step 0.02 / trail 0.15,
// from which rung should the trail be allowed to fire? minStopRung 8 is the value that
// restores the original contract exactly - 8 * 0.02 - 0.15 = +0.01, the first rung whose
// stop is at or above breakeven, which is what rung 1 meant under 15/15.
//
// METHOD. Same signal construction, same per-bar ordering, same cost model and same
// chronological out-of-sample split as orb-ratchet-research.js. Two deliberate differences:
//   - simulate() takes minStopRung instead of hardcoding `rung >= 1`.
//   - CACHE-ONLY. Signals whose contract is not already in logs/option-cache-orb.json are
//     SKIPPED rather than resolved over the network. Contract resolution is ~10k API calls
//     and this question does not justify paying it again. The cache was built 2026-08-04, so
//     the sample ends there; that is a smaller window, not a biased one, since the cache was
//     populated by a scan that had no knowledge of any ratchet setting. Coverage is printed
//     so the shortfall is visible rather than assumed away.
//
// Usage: node --env-file=.env scripts/orb-ratchet-minstoprung.js [days]
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const ratchet = require('../lib/ratchet');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30';
const FLATTEN = '15:45';
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');

const STEP = cfg.RATCHET_STEP_PCT;   // 0.02 live
const TRAIL = cfg.RATCHET_STOP_PCT;  // 0.15 live
const MINSTOP_GRID = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
const COST_GRID = [0, 0.04, 0.08];

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let all = [], tok = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: { symbols: symbol, timeframe: cfg.TIMEFRAME, start, limit: 10000, adjustment: 'split', feed: 'iex', page_token: tok || undefined },
    });
    all = all.concat(res.bars[symbol] || []);
    tok = res.next_page_token;
  } while (tok);
  return all;
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

// Byte-for-byte the ordering in orb-ratchet-research.js, with `rung >= 1` replaced by
// `rung >= minStopRung`. minStopRung 1 must therefore reproduce that script exactly, which
// is asserted below rather than assumed.
function simulate(sig, step, trail, cost, maxRungs, minStopRung, advanceOn = 'close') {
  const { optionBars, optParts, uByTime, entryIdx, orMid, isBull, day } = sig;
  const entry = optionBars[entryIdx].o;
  if (!entry || entry <= 0) return null;
  const net = (grossFrac) => (1 + grossFrac) * (1 - cost) - 1;

  let last = entry, rung = 0;
  for (let j = entryIdx; j < optionBars.length; j++) {
    const p = optParts[j];
    if (p.day !== day) continue;
    if (p.time >= FLATTEN) break;
    const bar = optionBars[j];
    last = bar.c;
    if (j === entryIdx) continue;

    const lowG = (bar.l - entry) / entry;
    const advG = ((advanceOn === 'high' ? bar.h : bar.c) - entry) / entry;

    if (lowG <= -cfg.OPTION_STOP_PCT) return { r: net(-cfg.OPTION_STOP_PCT), exit: 'option_stop', rung };
    if (step != null) {
      const { stop } = ratchet.levelsForRung(rung, step, trail);
      if (rung >= minStopRung && lowG <= stop) return { r: net(stop), exit: 'trail_stop', rung };
      rung = ratchet.rungFor(rung, advG, step, maxRungs);
    }
    const u = uByTime.get(p.time);
    if (u && (isBull ? u.l <= orMid : u.h >= orMid)) return { r: net((last - entry) / entry), exit: 'or_mid_stop', rung };
  }
  return { r: net((last - entry) / entry), exit: 'eod', rung };
}

function maxDD(rs) {
  let c = 0, pk = 0, w = 0;
  for (const r of rs) { c += r; if (c > pk) pk = c; if (pk - c > w) w = pk - c; }
  return w;
}

function stats(results) {
  const n = results.length;
  if (!n) return null;
  const chrono = results.slice().sort((a, b) => a.t - b.t);
  const rs = chrono.map((r) => r.r);
  const tot = rs.reduce((a, b) => a + b, 0);
  const mean = tot / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1));
  const losses = rs.filter((r) => r <= 0);
  return {
    n,
    expBp: mean * 10000,
    // The whole point of the exercise is downside, and expectancy on a fat-tailed sample is
    // dominated by a handful of trades. t is reported so "better" can be distinguished from
    // "one more good trade landed in this bucket".
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    lossRatePct: (losses.length / n) * 100,
    avgLossPct: (losses.reduce((a, b) => a + b, 0) / (losses.length || 1)) * 100,
    medianPct: [...rs].sort((a, b) => a - b)[Math.floor(n / 2)] * 100,
    worstPct: Math.min(...rs) * 100,
    maxDdPct: maxDD(rs) * 100,
    exits: results.reduce((a, r) => { a[r.exit] = (a[r.exit] || 0) + 1; return a; }, {}),
  };
}

const fmt = (label, s) =>
  `${label.padEnd(14)} n=${String(s.n).padStart(4)} exp=${s.expBp.toFixed(0).padStart(6)}bp t=${s.t.toFixed(2).padStart(5)} ` +
  `maxDD=${s.maxDdPct.toFixed(0).padStart(5)}% lossRate=${s.lossRatePct.toFixed(1).padStart(5)}% ` +
  `avgLoss=${s.avgLossPct.toFixed(1).padStart(7)}% med=${s.medianPct.toFixed(1).padStart(6)}%`;

const exitMix = (s) => Object.entries(s.exits).sort().map(([k, v]) => `${k}:${v}`).join(' ');

async function main() {
  const days = parseInt(process.argv[2] || '240', 10);
  console.log(`ORB ratchet minStopRung sweep | step ${STEP} trail ${TRAIL} | ${days} days | CACHE-ONLY\n`);

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
  console.log(`underlying bars fetched for ${data.length} symbols`);

  const raw = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const orBars = [];
      for (let i = firstIdx; i <= lastIdx; i++) if (parts[i].time >= '09:30' && parts[i].time < '09:45') orBars.push(bars[i]);
      if (orBars.length < OR_MINUTES / 5) continue;
      const orHigh = Math.max(...orBars.map((b) => b.h));
      const orLow = Math.min(...orBars.map((b) => b.l));
      const orMid = (orHigh + orLow) / 2;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:45' || parts[i].time >= CUTOFF) continue;
        if (!avgVol[i] || bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const bull = bars[i].c > orHigh, bear = bars[i].c < orLow;
        if (!bull && !bear) continue;
        raw.push({ symbol, day, time: parts[i].time, orMid, isBull: bull, price: bars[i].c, bars, parts, dayIndex, t: new Date(bars[i].t).getTime() });
        break;
      }
    }
  }
  console.log(`${raw.length} raw ORB signals`);

  if (!fs.existsSync(CACHE_FILE)) { console.log('no option cache - this script will not build one, aborting'); return; }
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  console.log(`option cache: ${Object.keys(cache).length} entries (read-only)`);

  const signals = [];
  let missing = 0, nullCached = 0;
  for (const s of raw) {
    const key = `${s.symbol}|${s.day}|${s.isBull ? 'C' : 'P'}`;
    if (!(key in cache)) { missing++; continue; }
    const c = cache[key];
    if (!c) { nullCached++; continue; }
    const optionBars = c.bars.map(([t, o, h, l, cl]) => ({ t, o, h, l, c: cl }));
    const optParts = optionBars.map(etParts);
    let entryIdx = -1;
    for (let j = 0; j < optionBars.length; j++) if (optParts[j].day === s.day && optParts[j].time >= s.time) { entryIdx = j; break; }
    if (entryIdx < 0) continue;
    const uByTime = new Map();
    const di = s.dayIndex.get(s.day);
    for (let i = di.firstIdx; i <= di.lastIdx; i++) uByTime.set(s.parts[i].time, s.bars[i]);
    signals.push({ ...s, optionBars, optParts, entryIdx, uByTime });
  }
  const cov = ((signals.length / raw.length) * 100).toFixed(1);
  console.log(`${signals.length} usable trades (${cov}% coverage; ${missing} not in cache, ${nullCached} cached as unresolvable)`);
  if (signals.length < 50) { console.log('too few trades, aborting'); return; }

  const dayspan = [...new Set(signals.map((s) => s.day))].sort();
  console.log(`window ${dayspan[0]} .. ${dayspan[dayspan.length - 1]} (${dayspan.length} sessions)\n`);

  const MAXR = cfg.RATCHET_MAX_RUNGS || 100;
  const run = (set, minStop, cost, step = STEP) => stats(set.map((s) => {
    const r = simulate(s, step, TRAIL, cost, MAXR, minStop);
    return r && { day: s.day, t: s.t, ...r };
  }).filter(Boolean));

  const chrono = signals.slice().sort((a, b) => a.t - b.t);
  const cut = Math.floor(chrono.length / 2);
  const inSample = chrono.slice(0, cut);
  const outSample = chrono.slice(cut);

  for (const cost of COST_GRID) {
    console.log(`${'='.repeat(96)}\nROUND-TRIP COST ${(cost * 100).toFixed(0)}%   (MAX_SPREAD_PCT is 8, so 4% ~ half the worst permitted spread)\n${'='.repeat(96)}`);
    console.log('-- FULL SAMPLE --');
    const off = run(signals, 0, cost, null);
    console.log(fmt('ratchet OFF', off), '|', exitMix(off));
    for (const ms of MINSTOP_GRID) {
      const s = run(signals, ms, cost);
      console.log(fmt(`minStopRung ${ms}`, s), '|', exitMix(s));
    }
    console.log('-- OUT OF SAMPLE (chronological 2nd half) --');
    const offO = run(outSample, 0, cost, null);
    console.log(fmt('ratchet OFF', offO), '|', exitMix(offO));
    for (const ms of MINSTOP_GRID) {
      const s = run(outSample, ms, cost);
      console.log(fmt(`minStopRung ${ms}`, s), '|', exitMix(s));
    }
    console.log('');
  }

  console.log(`in-sample n=${inSample.length}, out-of-sample n=${outSample.length}`);
  console.log('\nNOTE: minStopRung 8 is the value that restores the safety contract lib/config.js');
  console.log('states (8 * 0.02 - 0.15 = +0.01, the first rung whose stop is not a loss).');
  console.log('minStopRung 1 is what is deployed today.');
}

main().catch((e) => { console.error(e); process.exit(1); });
