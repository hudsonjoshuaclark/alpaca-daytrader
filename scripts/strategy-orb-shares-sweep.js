// Can ORB-15's edge be run as SHARES, on a wider universe than options liquidity allows?
//
// Why this is the strongest remaining candidate for the swing-signals account:
//   - ORB-15's edge was originally validated AT THE UNDERLYING LEVEL (scripts/sweep2-4.js:
//     +8bp/trade; scripts/sweep6-filters.js: 16.38bp -> 18.89bp with the relative-strength
//     filter). Those are share returns. The options bot is a LEVERAGED expression of it.
//   - It is the only strategy in this project with a live track record (+165%).
//   - Shares have no contract-liquidity constraint, so this can run the full 56-symbol
//     watchlist instead of the 12 names with tradeable weekly options.
//
// This replicates lib/marketData.js computeORBSignal exactly - 15-min opening range, first
// CONFIRMED breakout bar (rvol >= 1.5) before the 11:30 cutoff, one shot per symbol per day -
// and the live exit rules: stop when the underlying crosses back through the OR midpoint,
// otherwise flatten at 15:45. The or_mid check SKIPS the entry bar itself, matching both the
// backtest and the live fix made 2026-08-13 (a breakout bar's own wick can sit past orMid
// from before it closed outside the range).
//
// Universe split is the key test: ORB-15's own 12 names vs the OTHER 44. If the edge only
// exists on the 12 it was tuned on, it does not generalise and this is not deployable.
//
// Reads the bar cache from scripts/strategy-replacement-screen.js.
// Usage: node --env-file=.env scripts/strategy-orb-shares-sweep.js
const fs = require('fs');
const path = require('path');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const CACHE = path.join(__dirname, '..', 'logs', 'bars-cache-5min.json');
const BENCH = 'SPY';
const OR_BARS = cfg.ORB_MINUTES / 5;      // 15 min / 5-min bars = 3
const RVOL_MIN = cfg.ORB_RVOL_MIN;        // 1.5
const CUTOFF = cfg.ORB_ENTRY_CUTOFF;      // 11:30
const FLATTEN = cfg.FORCE_FLATTEN_AT;     // 15:45
const VOL_LOOKBACK = cfg.VOLUME_LOOKBACK; // 20

if (!fs.existsSync(CACHE)) {
  console.error(`No bar cache at ${CACHE} - run scripts/strategy-replacement-screen.js first.`);
  process.exit(1);
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

function prepare({ symbol, bars }) {
  const parts = bars.map(etParts);
  const avgVol = rollingAvgVolume(bars, VOL_LOOKBACK);
  const days = new Map();
  for (let i = 0; i < bars.length; i++) {
    const { day, time } = parts[i];
    if (time < '09:30' || time >= '16:00') continue;
    if (!days.has(day)) days.set(day, { idxs: [], openPrice: bars[i].o });
    days.get(day).idxs.push(i);
  }
  return { symbol, bars, parts, avgVol, days, dayList: [...days.keys()].sort() };
}

// One ORB signal per symbol per day, replicating computeORBSignal's scan order.
function orbSignals(S, { longOnly }) {
  const out = [];
  for (const day of S.dayList) {
    const idxs = S.days.get(day).idxs;
    if (idxs.length < OR_BARS + 1) continue;
    let orHigh = -Infinity, orLow = Infinity;
    for (let k = 0; k < OR_BARS; k++) {
      orHigh = Math.max(orHigh, S.bars[idxs[k]].h);
      orLow = Math.min(orLow, S.bars[idxs[k]].l);
    }
    const orMid = (orHigh + orLow) / 2;
    for (let k = OR_BARS; k < idxs.length; k++) {
      const i = idxs[k];
      if (S.parts[i].time >= CUTOFF) break;
      const bar = S.bars[i];
      const brokeUp = bar.c > orHigh, brokeDown = bar.c < orLow;
      if (!brokeUp && !brokeDown) continue;
      if (S.avgVol[i] == null || S.avgVol[i] <= 0) break;
      const rvol = bar.v / S.avgVol[i];
      // An unconfirmed breakout bar does NOT consume the day - keep scanning.
      if (rvol < RVOL_MIN) continue;
      const direction = brokeUp ? 'bullish' : 'bearish';
      if (longOnly && direction === 'bearish') break;
      out.push({
        symbol: S.symbol, day, entryIdx: i, entry: bar.c, direction, orMid, rvol,
        openPrice: S.days.get(day).openPrice, S,
      });
      break; // one shot per symbol per day
    }
  }
  return out;
}

// Live exit rules: or_mid cross (skipping the entry bar), else flatten at 15:45.
function simulate(S, sig) {
  const { entryIdx, day, entry, direction, orMid } = sig;
  let last = entry;
  for (let j = entryIdx + 1; j < S.bars.length; j++) {
    if (S.parts[j].day !== day) break;
    if (S.parts[j].time >= FLATTEN) break;
    const crossed = direction === 'bullish' ? S.bars[j].l <= orMid : S.bars[j].h >= orMid;
    if (crossed) {
      const r = direction === 'bullish' ? (orMid - entry) / entry : (entry - orMid) / entry;
      return { r, reason: 'or_mid_stop' };
    }
    last = S.bars[j].c;
  }
  const r = direction === 'bullish' ? (last - entry) / entry : (entry - last) / entry;
  return { r, reason: 'eod' };
}

function maxDrawdown(rs) {
  let cum = 0, peak = 0, worst = 0;
  for (const r of rs) { cum += r; if (cum > peak) peak = cum; if (peak - cum > worst) worst = peak - cum; }
  return worst;
}

function score(trades, costBp = 0) {
  const n = trades.length;
  if (!n) return null;
  const chrono = trades.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const rs = chrono.map((x) => x.r - costBp / 10000);
  const tot = rs.reduce((a, b) => a + b, 0);
  const cut = Math.floor(n * 0.7);
  const byMonth = new Map();
  chrono.forEach((x, k) => {
    const m = x.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(rs[k]);
  });
  const months = [...byMonth.entries()].sort()
    .map(([m, arr]) => ({ month: m, n: arr.length, expBp: (arr.reduce((a, b) => a + b, 0) / arr.length) * 10000 }));
  const isRs = rs.slice(0, cut), oosRs = rs.slice(cut);
  return {
    n,
    expBp: (tot / n) * 10000,
    winRatePct: (rs.filter((r) => r > 0).length / n) * 100,
    isExpBp: isRs.length ? (isRs.reduce((a, b) => a + b, 0) / isRs.length) * 10000 : 0,
    oosExpBp: oosRs.length ? (oosRs.reduce((a, b) => a + b, 0) / oosRs.length) * 10000 : 0,
    maxDdPct: maxDrawdown(rs) * 100,
    worstPct: Math.min(...rs) * 100,
    positiveMonths: months.filter((m) => m.expBp > 0).length,
    totalMonths: months.length,
    months,
    exits: trades.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {}),
  };
}

// Concurrency-capped, compounded, whole-share account sim. Ranks same-morning candidates by
// rvol (the live runner scans its universe in a fixed order, but rvol is the quality signal
// the strategy already believes in and is reproducible live).
function simulateAccount(sigs, { maxConcurrent, riskPct, costBp, startEquity = 1000 }) {
  const byDay = new Map();
  for (const s of sigs) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  let equity = startEquity, peak = startEquity, maxDd = 0, taken = 0, wins = 0;
  for (const day of [...byDay.keys()].sort()) {
    const picks = byDay.get(day).sort((a, b) => b.rvol - a.rvol).slice(0, maxConcurrent);
    let dayPnl = 0;
    for (const p of picks) {
      const { r } = simulate(p.S, p);
      const net = r - costBp / 10000;
      const qty = Math.floor((equity * riskPct) / p.entry);
      if (qty < 1) continue;
      dayPnl += qty * p.entry * net;
      taken += 1;
      if (net > 0) wins += 1;
    }
    equity += dayPnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    finalEquity: equity, returnPct: ((equity - startEquity) / startEquity) * 100,
    maxDdPct: maxDd * 100, trades: taken, winRatePct: taken ? (wins / taken) * 100 : 0,
  };
}

function line(label, st, tradingDays) {
  return `${label.padEnd(34)} n=${String(st.n).padStart(5)} rate=${((st.n / tradingDays) * 252).toFixed(0).padStart(4)}/yr ` +
    `exp=${st.expBp.toFixed(1).padStart(7)}bp win%=${st.winRatePct.toFixed(1).padStart(4)} ` +
    `IS=${st.isExpBp.toFixed(1).padStart(7)} OOS=${st.oosExpBp.toFixed(1).padStart(7)} ` +
    `maxDD=${st.maxDdPct.toFixed(0).padStart(4)}% worst=${st.worstPct.toFixed(1).padStart(6)}% mo+=${st.positiveMonths}/${st.totalMonths}`;
}

function main() {
  const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const prepared = cached.symbols.map(prepare);
  const universe = prepared.filter((p) => p.symbol !== BENCH);
  const tradingDays = new Set(universe.flatMap((p) => p.dayList)).size;
  const ORB12 = new Set(cfg.UNIVERSE);
  console.log(`${universe.length} symbols, ${tradingDays} trading days.`);
  console.log(`ORB-15's own universe (${ORB12.size}): ${[...ORB12].join(',')}\n`);

  for (const longOnly of [false, true]) {
    console.log(`=== ${longOnly ? 'LONG ONLY' : 'LONG + SHORT'} (no cost) ===`);
    const groups = {
      'all 56': universe,
      'ORB-15 own 12': universe.filter((p) => ORB12.has(p.symbol)),
      'other 44 (unseen)': universe.filter((p) => !ORB12.has(p.symbol)),
    };
    for (const [label, syms] of Object.entries(groups)) {
      const sigs = [];
      for (const S of syms) sigs.push(...orbSignals(S, { longOnly }));
      const trades = sigs.map((s) => ({ day: s.day, ...simulate(s.S, s) }));
      const st = score(trades);
      if (!st) { console.log(`  ${label}: no signals`); continue; }
      console.log('  ' + line(label, st, tradingDays));
    }
    console.log('');
  }

  // Cost sensitivity + account sim on the full universe, long-only (shorting a $1000 paper
  // account adds margin/borrow complications the other bots deliberately avoid).
  console.log('=== cost sensitivity, all 56, long only ===');
  const sigsAll = [];
  for (const S of universe) sigsAll.push(...orbSignals(S, { longOnly: true }));
  const tradesAll = sigsAll.map((s) => ({ day: s.day, ...simulate(s.S, s) }));
  console.log('  ' + [0, 2, 5, 10].map((c) => `${c}bp:${score(tradesAll, c).expBp.toFixed(1).padStart(6)}`).join('   '));

  console.log('\n=== account simulation ($1000 start, 5bp cost, whole shares) ===');
  for (const riskPct of [0.15, 0.25]) {
    for (const maxC of [3, 4, 6]) {
      const r = simulateAccount(sigsAll, { maxConcurrent: maxC, riskPct, costBp: 5 });
      console.log(`  risk=${(riskPct * 100).toFixed(0)}% max${maxC} -> $${r.finalEquity.toFixed(0).padStart(6)} ` +
        `(${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%) maxDD=${r.maxDdPct.toFixed(1).padStart(5)}% ` +
        `trades=${String(r.trades).padStart(4)} win%=${r.winRatePct.toFixed(1)}`);
    }
  }

  const st = score(tradesAll, 5);
  console.log(`\n=== monthly, all 56, long only, 5bp cost (exp ${st.expBp.toFixed(1)}bp, IS ${st.isExpBp.toFixed(1)}, OOS ${st.oosExpBp.toFixed(1)}) ===`);
  console.log('  ' + st.months.map((m) => `${m.month.slice(2)}:${m.expBp.toFixed(0)}`).join('  '));
  console.log(`  exits=${JSON.stringify(st.exits)}  positive months=${st.positiveMonths}/${st.totalMonths}`);
}

main();
