// Validation gauntlet for the one candidate that survived scripts/strategy-replacement-screen.js:
// GAP-UP CONTINUATION - a name that opened >=X% above yesterday's close and is trading above
// its EMA(50) at 09:35 is bought and held into the 15:45 flatten.
//
// The screen said n=1663, +14.08bp, IS 14.0 / OOS 14.1. That IS/OOS stability is the reason
// this got a second look at all. But a single grid row is not evidence, and +14bp is thin
// enough that costs matter. Four ways this could still be fake, each tested here:
//
//   1. PARAMETER FIT - does the edge exist only at exactly 1.5%? A real effect should decay
//      smoothly across neighbouring thresholds, not spike at one.
//   2. TRANSACTION COST - Alpaca charges no equity commission, but the bid/ask is real.
//      Expectancy is re-scored with 0/2/5/10bp of round-trip cost subtracted per trade.
//   3. CONCURRENCY - the screen takes every signal equally weighted. The live bot can only
//      hold MAX_CONCURRENT positions, all entered the same minute in correlated gap-up
//      names. Simulated properly here, compounding a real account balance.
//   4. TAIL - EOD-hold has no stop and its worst trade was -15.3%. Stop variants are scored
//      to see how much expectancy a tail cap actually costs.
//
// Reads the bar cache written by strategy-replacement-screen.js (delete it to refetch).
// Usage: node --env-file=.env scripts/strategy-gapup-validate.js
const fs = require('fs');
const path = require('path');
const { ema } = require('../lib/indicators');

const CACHE = path.join(__dirname, '..', 'logs', 'bars-cache-5min.json');
const EXIT_TIME = '15:45';
const ENTRY_TIME = '09:35';
const BENCH = 'SPY';

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
  const ema50 = ema(bars.map((b) => b.c), 50);
  const days = new Map();
  for (let i = 0; i < bars.length; i++) {
    const { day, time } = parts[i];
    if (time < '09:30' || time >= '16:00') continue;
    if (!days.has(day)) days.set(day, { idxs: [], openPrice: bars[i].o });
    days.get(day).idxs.push(i);
  }
  const dayList = [...days.keys()].sort();
  for (let d = 1; d < dayList.length; d++) {
    const prev = days.get(dayList[d - 1]);
    days.get(dayList[d]).prevClose = bars[prev.idxs[prev.idxs.length - 1]].c;
  }
  return { symbol, bars, parts, ema50, days, dayList };
}

// Signals for a given gap threshold. Also records gap size, used to rank when the live
// concurrency cap forces a choice between same-morning candidates.
function signals(S, gapPct) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    if (d.prevClose == null) continue;
    const gap = (d.openPrice - d.prevClose) / d.prevClose;
    if (gap < gapPct) continue;
    const i = d.idxs.find((k) => S.parts[k].time >= ENTRY_TIME);
    if (i == null || S.ema50[i] == null) continue;
    if (!(S.bars[i].c > S.ema50[i])) continue;
    out.push({ symbol: S.symbol, day, entryIdx: i, entry: S.bars[i].c, gap, S });
  }
  return out;
}

// Exit sims. Stop-before-target on an ambiguous bar (the conservative reading used by every
// sweep in this repo).
function simulate(S, entryIdx, day, entry, { stop = null, target = null }) {
  const slLevel = stop ? entry * (1 - stop) : null;
  const tpLevel = target ? entry * (1 + target) : null;
  let last = entry;
  for (let j = entryIdx + 1; j < S.bars.length; j++) {
    if (S.parts[j].day !== day) break;
    if (S.parts[j].time >= EXIT_TIME) break;
    if (slLevel !== null && S.bars[j].l <= slLevel) return { r: -stop, reason: 'stop' };
    if (tpLevel !== null && S.bars[j].h >= tpLevel) return { r: target, reason: 'target' };
    last = S.bars[j].c;
  }
  return { r: (last - entry) / entry, reason: 'eod' };
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
  const isRs = rs.slice(0, cut), oosRs = rs.slice(cut);
  const byMonth = new Map();
  chrono.forEach((x, k) => {
    const m = x.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(rs[k]);
  });
  const months = [...byMonth.entries()].sort()
    .map(([m, arr]) => ({ month: m, n: arr.length, expBp: (arr.reduce((a, b) => a + b, 0) / arr.length) * 10000 }));
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

// Realistic account simulation: at most maxConcurrent positions per day, chosen by largest
// gap first (a deterministic rule the live bot can reproduce), each sized at riskPct of the
// CURRENT balance, compounding day by day. This is the number that actually matters - the
// equal-weighted expectancy above ignores both the cap and compounding.
function simulateAccount(allSignals, exitCfg, { maxConcurrent, riskPct, costBp, startEquity = 1000 }) {
  const byDay = new Map();
  for (const s of allSignals) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  let equity = startEquity;
  let peak = startEquity, maxDd = 0, taken = 0, wins = 0;
  const daily = [];
  for (const day of [...byDay.keys()].sort()) {
    const picks = byDay.get(day).sort((a, b) => b.gap - a.gap).slice(0, maxConcurrent);
    let dayPnl = 0;
    for (const p of picks) {
      const { r } = simulate(p.S, p.entryIdx, p.day, p.entry, exitCfg);
      const net = r - costBp / 10000;
      // Whole shares only, like the live bot: budget/price floored.
      const budget = equity * riskPct;
      const qty = Math.floor(budget / p.entry);
      if (qty < 1) continue;
      dayPnl += qty * p.entry * net;
      taken += 1;
      if (net > 0) wins += 1;
    }
    equity += dayPnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
    daily.push({ day, equity });
  }
  return {
    finalEquity: equity,
    returnPct: ((equity - startEquity) / startEquity) * 100,
    maxDdPct: maxDd * 100,
    trades: taken,
    winRatePct: taken ? (wins / taken) * 100 : 0,
    daily,
  };
}

function main() {
  const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const prepared = cached.symbols.map(prepare);
  const universe = prepared.filter((p) => p.symbol !== BENCH);
  const tradingDays = new Set(universe.flatMap((p) => p.dayList)).size;
  console.log(`${universe.length} symbols, ${tradingDays} trading days (cache fetched ${cached.fetchedAt}).\n`);

  const GAPS = [0.010, 0.015, 0.020, 0.025, 0.030];
  const EXITS = [
    { key: 'EOD only (no stop)', cfg: {} },
    { key: 'stop 2%', cfg: { stop: 0.02 } },
    { key: 'stop 3%', cfg: { stop: 0.03 } },
    { key: 'stop 4%', cfg: { stop: 0.04 } },
    { key: 'stop 5%', cfg: { stop: 0.05 } },
    { key: 'bracket 1.5/2.0', cfg: { stop: 0.015, target: 0.020 } },
  ];

  // ---- 1. Parameter robustness -------------------------------------------------------
  console.log('=== 1. gap threshold x exit (equal-weighted, no cost) ===');
  console.log('   A real effect decays smoothly across thresholds; a fitted one spikes.\n');
  const sigCache = new Map();
  for (const g of GAPS) {
    const all = [];
    for (const S of universe) all.push(...signals(S, g));
    sigCache.set(g, all);
    for (const e of EXITS) {
      const trades = all.map((s) => ({ day: s.day, ...simulate(s.S, s.entryIdx, s.day, s.entry, e.cfg) }));
      const st = score(trades);
      if (!st) continue;
      console.log(
        `  gap>=${(g * 100).toFixed(1)}% ${e.key.padEnd(20)} n=${String(st.n).padStart(5)} ` +
        `rate=${((st.n / tradingDays) * 252).toFixed(0).padStart(5)}/yr exp=${st.expBp.toFixed(1).padStart(7)}bp ` +
        `win%=${st.winRatePct.toFixed(1).padStart(4)} IS=${st.isExpBp.toFixed(1).padStart(7)} ` +
        `OOS=${st.oosExpBp.toFixed(1).padStart(7)} worst=${st.worstPct.toFixed(1).padStart(6)}% mo+=${st.positiveMonths}/${st.totalMonths}`
      );
    }
    console.log('');
  }

  // ---- 2. Transaction cost sensitivity ------------------------------------------------
  console.log('=== 2. transaction cost sensitivity (gap>=1.5%) ===');
  console.log('   Liquid mega-cap round trip is roughly 2-5bp. 10bp is a pessimistic stress.\n');
  const base = sigCache.get(0.015);
  for (const e of EXITS) {
    const trades = base.map((s) => ({ day: s.day, ...simulate(s.S, s.entryIdx, s.day, s.entry, e.cfg) }));
    const line = [0, 2, 5, 10].map((c) => {
      const st = score(trades, c);
      return `${c}bp:${st.expBp.toFixed(1).padStart(6)}`;
    }).join('  ');
    console.log(`  ${e.key.padEnd(20)} ${line}`);
  }

  // ---- 3. Realistic account simulation -------------------------------------------------
  console.log('\n=== 3. account simulation: concurrency-capped, compounded, $1000 start ===');
  console.log('   Equal-weighted expectancy ignores BOTH the position cap and compounding.');
  console.log('   Picks the largest gaps first - a rule the live runner can reproduce exactly.\n');
  for (const g of [0.015, 0.020, 0.025]) {
    for (const e of EXITS) {
      for (const maxC of [3, 5]) {
        const r = simulateAccount(sigCache.get(g), e.cfg, { maxConcurrent: maxC, riskPct: 0.12, costBp: 5 });
        console.log(
          `  gap>=${(g * 100).toFixed(1)}% ${e.key.padEnd(20)} max${maxC} -> ` +
          `$${r.finalEquity.toFixed(0).padStart(6)} (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%) ` +
          `maxDD=${r.maxDdPct.toFixed(1).padStart(5)}% trades=${String(r.trades).padStart(4)} win%=${r.winRatePct.toFixed(1)}`
        );
      }
    }
    console.log('');
  }

  // ---- 4. Monthly detail for the leading configurations ---------------------------------
  console.log('=== 4. month-by-month, gap>=1.5%, 5bp cost ===\n');
  for (const e of [EXITS[0], EXITS[3], EXITS[5]]) {
    const trades = base.map((s) => ({ day: s.day, ...simulate(s.S, s.entryIdx, s.day, s.entry, e.cfg) }));
    const st = score(trades, 5);
    console.log(`  ${e.key} (exp ${st.expBp.toFixed(1)}bp, IS ${st.isExpBp.toFixed(1)}, OOS ${st.oosExpBp.toFixed(1)}, mo+ ${st.positiveMonths}/${st.totalMonths})`);
    console.log('    ' + st.months.map((m) => `${m.month.slice(2)}:${m.expBp.toFixed(0)}`).join('  '));
    console.log(`    exits=${JSON.stringify(st.exits)}\n`);
  }
}

main();
