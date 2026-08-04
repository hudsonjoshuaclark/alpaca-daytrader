// Deeper research pass on ORB-15's ratcheting profit floor, addressing the three gaps left
// open by scripts/orb-ratchet-sweep.js (2026-08-03):
//
//   1. BOUNDARY OPTIMUM. That grid bottomed out at step/trail 10% and 10/10 scored best,
//      which tells you nothing except that the optimum is at or below the edge. This one
//      extends down to 2% so the optimum can be located rather than clipped.
//   2. NO COST MODEL. Exits were assumed to fill exactly at the stop level. The live bot
//      exits at MARKET and MAX_SPREAD_PCT admits an 8% bid-ask, so every exit gives up
//      part of the spread. Modelled here as a round-trip cost on the exit premium, swept
//      so you can see what survives realistic friction.
//   3. NO OUT-OF-SAMPLE. Four months, all positive, single grid fit to all of it. This
//      splits the window chronologically and fits on the first half, then reports how that
//      choice actually performed on the second - the only number that means anything for
//      "what should I set it to".
//
// Also caches resolved option contracts to logs/option-cache-orb.json, because contract
// resolution is the entire runtime cost (~10k API calls) and without a cache no follow-up
// question can be answered without paying it again.
//
// Usage: node --env-file=.env scripts/orb-ratchet-research.js [days]
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
const ZERO_DTE = new Set(['SPY', 'QQQ']);
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');

// Extended down to 2%: the previous grid's best was its own tightest cell.
const STEP_GRID = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
const TRAIL_GRID = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
// Round-trip friction as a fraction of exit premium. MAX_SPREAD_PCT is 8, so 4% ~ paying
// half the worst permitted spread; 8% ~ paying all of it.
const COST_GRID = [0, 0.02, 0.04, 0.08];

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

async function getOptionBars(occ, dayStart, dayEnd) {
  try {
    const res = await client.data('/v1beta1/options/bars', {
      params: { symbols: occ, timeframe: '5Min', start: dayStart, end: dayEnd, limit: 500 },
    });
    return (res.bars && res.bars[occ]) || [];
  } catch { return []; }
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}
function nextFriday(dayStr) {
  const d = new Date(`${dayStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}
function occSym(root, exp, type, strike) {
  return `${root}${exp.slice(2).replace(/-/g, '')}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

// Candidates are probed in ascending distance from ATM and the FIRST one with bars wins.
// That returns exactly the same contract the old "probe all, keep closest" loop did, since
// scanning in distance order finds the closest-with-data first - but it stops early instead
// of always paying ~25 requests per signal.
async function resolveContract(symbol, day, isBull, price) {
  const type = isBull ? 'call' : 'put';
  const exp = ZERO_DTE.has(symbol) ? day : nextFriday(day);
  const incs = price < 50 ? [1, 2.5, 0.5] : price < 300 ? [2.5, 5, 1] : [5, 2.5, 10];
  const cands = new Set();
  for (const inc of incs) {
    const base = Math.round(price / inc) * inc;
    for (const off of [0, -1, 1, -2, 2]) cands.add(+(base + off * inc).toFixed(2));
  }
  const ordered = [...cands].filter((s) => s > 0).sort((a, b) => Math.abs(a - price) - Math.abs(b - price));
  for (const strike of ordered) {
    const occ = occSym(symbol, exp, type, strike);
    const bars = await getOptionBars(occ, `${day}T00:00:00Z`, `${day}T23:59:59Z`);
    if (bars.length) return { occ, strike, bars };
  }
  return null;
}

// Same per-bar ordering as the deployed bot and the previous sweep: catastrophic stop, then
// the ratchet trail (armed only from rung 1, matching minStopRung: 1 in runner.js), then
// ratchet advance on the high, then or_mid_stop. Adverse-first on every ambiguous bar.
// `cost` is applied to the realised exit premium - a market exit gives up spread.
// `advanceOn` is the single most consequential modelling choice here, and the previous
// sweep got it wrong by not treating it as a choice at all:
//
//   'high'  - ratchet off the bar HIGH. This is what orb-ratchet-sweep.js did, and it is
//             a LOOK-AHEAD ARTIFACT. The rung jumps to the intrabar peak and the stop is
//             then parked just under it, so the sim books an exit at roughly the high of a
//             5-min bar. As step/trail shrink toward zero this degenerates into selling at
//             the perfect top, which is why every grid run so far has "optimised" straight
//             into its own tightest cell.
//   'close' - ratchet only off the bar CLOSE, a price the market actually printed and held.
//             The live bot polls every 20s off the position mark; it sees roughly 15 prices
//             per 5-min bar and cannot be assumed to catch the exact peak of each one.
//
// Truth sits between the two, but only 'close' is defensible as a floor. Both are reported
// so the sensitivity is visible rather than hidden inside a single number.
function simulate(sig, step, trail, cost, maxRungs, advanceOn = 'close') {
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
      if (rung >= 1 && lowG <= stop) return { r: net(stop), exit: 'trail_stop', rung };
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
  const losses = rs.filter((r) => r <= 0);
  const byMonth = new Map();
  for (const r of chrono) {
    const m = r.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r.r);
  }
  const months = [...byMonth.entries()].sort().map(([m, a]) => ({ month: m, n: a.length, expBp: (a.reduce((x, y) => x + y, 0) / a.length) * 10000 }));
  return {
    n,
    expBp: (tot / n) * 10000,
    totPct: tot * 100,
    lossRatePct: (losses.length / n) * 100,
    avgLossPct: (losses.reduce((a, b) => a + b, 0) / (losses.length || 1)) * 100,
    worstPct: Math.min(...rs) * 100,
    maxDdPct: maxDD(rs) * 100,
    months,
    posMonths: months.filter((m) => m.expBp > 0).length,
    exits: results.reduce((a, r) => { a[r.exit] = (a[r.exit] || 0) + 1; return a; }, {}),
    avgRung: results.reduce((a, r) => a + (r.rung || 0), 0) / n,
  };
}

const fmt = (label, s) =>
  `${label.padEnd(22)} n=${String(s.n).padStart(4)} exp=${s.expBp.toFixed(0).padStart(6)}bp maxDD=${s.maxDdPct.toFixed(0).padStart(5)}% ` +
  `lossRate=${s.lossRatePct.toFixed(1).padStart(5)}% avgLoss=${s.avgLossPct.toFixed(1).padStart(7)}% mo+=${s.posMonths}/${s.months.length}`;

async function main() {
  const days = parseInt(process.argv[2] || '240', 10);
  console.log(`ORB ratchet research | ${days} days | grid ${STEP_GRID.length}x${TRAIL_GRID.length} | costs ${COST_GRID.map((c) => (c * 100) + '%').join(',')}\n`);

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

  let cache = {};
  if (fs.existsSync(CACHE_FILE)) { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); console.log(`option cache: ${Object.keys(cache).length} entries`); }

  const signals = [];
  let done = 0, fetched = 0;
  for (const s of raw) {
    const key = `${s.symbol}|${s.day}|${s.isBull ? 'C' : 'P'}`;
    if (!(key in cache)) {
      const c = await resolveContract(s.symbol, s.day, s.isBull, s.price);
      cache[key] = c ? { occ: c.occ, bars: c.bars.map((b) => [b.t, b.o, b.h, b.l, b.c]) } : null;
      fetched++;
      if (fetched % 25 === 0) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); console.log(`  resolved ${fetched} new (${done}/${raw.length} scanned)`); }
    }
    done++;
    const c = cache[key];
    if (!c) continue;
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
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`${signals.length} usable trades (${fetched} newly resolved, cache now ${Object.keys(cache).length})\n`);
  if (signals.length < 50) { console.log('too few trades, aborting'); return; }

  const MAXR = cfg.RATCHET_MAX_RUNGS || 100;
  const run = (set, step, trail, cost, mode) => stats(set.map((s) => {
    const r = simulate(s, step, trail, cost, MAXR, mode);
    return r && { day: s.day, t: s.t, ...r };
  }).filter(Boolean));

  const sorted = signals.slice().sort((a, b) => a.t - b.t);
  const mid = Math.floor(sorted.length / 2);
  const inSample = sorted.slice(0, mid);
  const outSample = sorted.slice(mid);
  console.log(`Chronological split: in-sample n=${inSample.length} (${inSample[0].day}..${inSample[inSample.length - 1].day}), out-of-sample n=${outSample.length} (${outSample[0].day}..${outSample[outSample.length - 1].day})\n`);

  for (const mode of ['high', 'close']) {
    console.log(`\n\n${'#'.repeat(100)}`);
    console.log(`# RATCHET ADVANCES ON BAR ${mode.toUpperCase()}` +
      (mode === 'high' ? '   <- look-ahead: books exits near the intrabar peak, NOT achievable live'
                       : '  <- conservative: only prices the market actually closed at'));
    console.log(`${'#'.repeat(100)}`);

    for (const cost of COST_GRID) {
      console.log(`\n${'='.repeat(96)}\nROUND-TRIP COST ${(cost * 100).toFixed(0)}% of exit premium   [advance on ${mode}]\n${'='.repeat(96)}`);
      const control = run(signals, null, null, cost, mode);
      console.log(fmt('CONTROL ratchet off', control));

      const rows = [];
      for (const step of STEP_GRID) for (const trail of TRAIL_GRID) {
        const s = run(signals, step, trail, cost, mode);
        s.step = step; s.trail = trail;
        rows.push(s);
      }
      const viable = rows.filter((r) => r.expBp > 0);
      const byDd = viable.slice().sort((a, b) => a.maxDdPct - b.maxDdPct);
      const byExp = rows.slice().sort((a, b) => b.expBp - a.expBp);
      console.log(`\n  best by max drawdown:`);
      for (const r of byDd.slice(0, 5)) console.log('    ' + fmt(`step=${(r.step * 100).toFixed(0)} trail=${(r.trail * 100).toFixed(0)}`, r));
      console.log(`  best by expectancy:`);
      for (const r of byExp.slice(0, 5)) console.log('    ' + fmt(`step=${(r.step * 100).toFixed(0)} trail=${(r.trail * 100).toFixed(0)}`, r));

      const isRows = [];
      for (const step of STEP_GRID) for (const trail of TRAIL_GRID) {
        const s = run(inSample, step, trail, cost, mode);
        if (s) { s.step = step; s.trail = trail; isRows.push(s); }
      }
      const pickDd = isRows.filter((r) => r.expBp > 0).sort((a, b) => a.maxDdPct - b.maxDdPct)[0];
      const pickExp = isRows.slice().sort((a, b) => b.expBp - a.expBp)[0];
      console.log(`\n  WALK-FORWARD (choose on first half, judge on second):`);
      const oosCtl = run(outSample, null, null, cost, mode);
      for (const [name, pick] of [['min-drawdown pick', pickDd], ['max-expectancy pick', pickExp]]) {
        if (!pick) continue;
        const oos = run(outSample, pick.step, pick.trail, cost, mode);
        console.log(`    ${name} -> step=${(pick.step * 100).toFixed(0)} trail=${(pick.trail * 100).toFixed(0)}`);
        console.log('      in-sample  ' + fmt('', pick));
        console.log('      OUT-SAMPLE ' + fmt('', oos));
      }
      console.log('      oos control' + fmt('', oosCtl));

      const dep = rows.find((r) => Math.abs(r.step - cfg.RATCHET_STEP_PCT) < 1e-9 && Math.abs(r.trail - cfg.RATCHET_STOP_PCT) < 1e-9);
      if (dep) console.log('\n  ' + fmt(`DEPLOYED ${(cfg.RATCHET_STEP_PCT * 100).toFixed(0)}/${(cfg.RATCHET_STOP_PCT * 100).toFixed(0)}`, dep));
    }
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
