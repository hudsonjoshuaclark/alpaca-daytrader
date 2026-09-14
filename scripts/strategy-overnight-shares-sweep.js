// Overnight drift, run as SHARES on the wider watchlist - candidate to replace swing-signals.
//
// The case for this being the strongest remaining option: the overnight-drift backtest that
// justified deploying that bot (scripts/strategy-overnight-sweep.js, 2026-07-28: +7 to +16bp
// per trade across every threshold tested, n=230-568, long side only - the short side tested
// NEGATIVE at -12.23bp and was never implemented) measured CLOSE-TO-OPEN RETURNS ON THE
// UNDERLYING. That is literally a shares strategy. The live bot expresses it through call
// debit spreads only because it shares an options account; that indirection is what costs it
// ~43% of its signals to unfilled limit orders (3 of 7 expired between 08-03 and 08-13) and
// what forces the affordability rejections in its logs ("spread debit $237 > budget $162").
//
// Shares remove all of that: near-certain fills, exact sizing, no contract selection, and
// the whole 56-symbol watchlist instead of 12 optionable names.
//
// Signal, matching strategies/overnight-drift/config.js: at 15:55 ET buy any name whose
// return from today's open is >= TODAY_RETURN_THRESHOLD; sell at the next session's open.
// LONG ONLY, deliberately - implementing the short side would be shipping an idea the
// original sweep already rejected.
//
// Tested honestly: the threshold is swept (a real effect decays smoothly), overnight gap
// risk is reported as worst-trade and tail figures rather than hidden in an average, costs
// are stressed, and a concurrency-capped compounded account sim is run because that is what
// actually determines whether this makes money on $1,000.
//
// Reads the bar cache from scripts/strategy-replacement-screen.js.
// Usage: node --env-file=.env scripts/strategy-overnight-shares-sweep.js
const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, '..', 'logs', 'bars-cache-5min.json');
const BENCH = 'SPY';
const ENTRY_TIME = '15:55';
const EXIT_TIME = '09:35'; // next session, matching the live exit task

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
  const days = new Map();
  for (let i = 0; i < bars.length; i++) {
    const { day, time } = parts[i];
    if (time < '09:30' || time >= '16:00') continue;
    if (!days.has(day)) days.set(day, { idxs: [], openPrice: bars[i].o });
    days.get(day).idxs.push(i);
  }
  return { symbol, bars, parts, days, dayList: [...days.keys()].sort() };
}

// Entry: last bar at/after 15:55 on day D. Exit: first bar at/after 09:35 on day D+1.
function signals(S, threshold) {
  const out = [];
  for (let d = 0; d < S.dayList.length - 1; d++) {
    const day = S.dayList[d], next = S.dayList[d + 1];
    const info = S.days.get(day);
    const entryIdx = info.idxs.filter((i) => S.parts[i].time >= ENTRY_TIME).pop();
    if (entryIdx == null) continue;
    const entry = S.bars[entryIdx].c;
    const todayReturn = (entry - info.openPrice) / info.openPrice;
    if (todayReturn < threshold) continue;

    const nextInfo = S.days.get(next);
    const exitIdx = nextInfo.idxs.find((i) => S.parts[i].time >= EXIT_TIME);
    if (exitIdx == null) continue;
    const exit = S.bars[exitIdx].c;
    out.push({
      symbol: S.symbol, day, entry, exit, todayReturn,
      r: (exit - entry) / entry,
    });
  }
  return out;
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
  const sorted = rs.slice().sort((a, b) => a - b);
  return {
    n,
    expBp: (tot / n) * 10000,
    winRatePct: (rs.filter((r) => r > 0).length / n) * 100,
    isExpBp: (rs.slice(0, cut).reduce((a, b) => a + b, 0) / cut) * 10000,
    oosExpBp: (rs.slice(cut).reduce((a, b) => a + b, 0) / (n - cut)) * 10000,
    maxDdPct: maxDrawdown(rs) * 100,
    worstPct: sorted[0] * 100,
    p1Pct: sorted[Math.floor(n * 0.01)] * 100,
    positiveMonths: months.filter((m) => m.expBp > 0).length,
    totalMonths: months.length,
    months,
  };
}

function simulateAccount(sigs, { maxConcurrent, riskPct, costBp, startEquity = 1000 }) {
  const byDay = new Map();
  for (const s of sigs) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  let equity = startEquity, peak = startEquity, maxDd = 0, taken = 0, wins = 0;
  for (const day of [...byDay.keys()].sort()) {
    // Strongest movers first - reproducible live from the same data the runner already has.
    const picks = byDay.get(day).sort((a, b) => b.todayReturn - a.todayReturn).slice(0, maxConcurrent);
    let dayPnl = 0;
    for (const p of picks) {
      const net = p.r - costBp / 10000;
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

function main() {
  const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const prepared = cached.symbols.map(prepare);
  const universe = prepared.filter((p) => p.symbol !== BENCH);
  const tradingDays = new Set(universe.flatMap((p) => p.dayList)).size;
  const OV12 = new Set(['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR']);
  console.log(`${universe.length} symbols, ${tradingDays} trading days.\n`);

  // THE CONTROL THAT MATTERS. Everything below is long-only overnight exposure during a
  // 12-month sample. If simply holding ANY name overnight paid about the same, then the
  // "up >= X% today" filter contributes nothing and this is just beta with extra steps.
  // Measured three ways: every name every night, the DOWN-day cohort the strategy skips,
  // and SPY buy-and-hold over the identical window.
  console.log('=== 0. CONTROL: is the signal doing anything, or is this just beta? ===\n');
  {
    const all = [];
    for (const S of universe) all.push(...signals(S, -Infinity));
    const stAll = score(all);
    const down = all.filter((t) => t.todayReturn < 0);
    const stDown = score(down);
    const up1 = all.filter((t) => t.todayReturn >= 0.010);
    const stUp = score(up1);
    console.log(`  every name, every night   n=${String(stAll.n).padStart(5)} exp=${stAll.expBp.toFixed(1).padStart(6)}bp win%=${stAll.winRatePct.toFixed(1)}`);
    console.log(`  DOWN-day cohort (skipped) n=${String(stDown.n).padStart(5)} exp=${stDown.expBp.toFixed(1).padStart(6)}bp win%=${stDown.winRatePct.toFixed(1)}`);
    console.log(`  UP >=1.0% cohort (traded) n=${String(stUp.n).padStart(5)} exp=${stUp.expBp.toFixed(1).padStart(6)}bp win%=${stUp.winRatePct.toFixed(1)}`);
    console.log(`  -> filter edge over unconditional: ${(stUp.expBp - stAll.expBp).toFixed(1)}bp/trade\n`);

    const spy = prepared.find((p) => p.symbol === BENCH);
    if (spy) {
      const first = spy.days.get(spy.dayList[0]).openPrice;
      const lastDay = spy.days.get(spy.dayList[spy.dayList.length - 1]);
      const lastPx = spy.bars[lastDay.idxs[lastDay.idxs.length - 1]].c;
      console.log(`  SPY buy-and-hold same window: ${(((lastPx - first) / first) * 100).toFixed(1)}%`);
      // Overnight-only slice of SPY: what pure "hold the index overnight" earned.
      const spyNights = signals(spy, -Infinity);
      const stSpy = score(spyNights);
      console.log(`  SPY held ONLY overnight:      n=${stSpy.n} exp=${stSpy.expBp.toFixed(1)}bp total=${(stSpy.expBp * stSpy.n / 10000 * 100).toFixed(1)}%\n`);
    }
  }

  const THRESHOLDS = [0.005, 0.010, 0.015, 0.020, 0.030];

  console.log('=== 1. threshold sweep, all 56 symbols, no cost ===');
  console.log('   A real effect decays smoothly across thresholds.\n');
  const cacheSigs = new Map();
  for (const th of THRESHOLDS) {
    const sigs = [];
    for (const S of universe) sigs.push(...signals(S, th));
    cacheSigs.set(th, sigs);
    const st = score(sigs);
    if (!st) { console.log(`  >=${(th * 100).toFixed(1)}%: none`); continue; }
    console.log(
      `  today>=${(th * 100).toFixed(1)}%  n=${String(st.n).padStart(5)} rate=${((st.n / tradingDays) * 252).toFixed(0).padStart(5)}/yr ` +
      `exp=${st.expBp.toFixed(1).padStart(6)}bp win%=${st.winRatePct.toFixed(1).padStart(4)} ` +
      `IS=${st.isExpBp.toFixed(1).padStart(6)} OOS=${st.oosExpBp.toFixed(1).padStart(6)} ` +
      `worst=${st.worstPct.toFixed(1).padStart(6)}% p1=${st.p1Pct.toFixed(1).padStart(5)}% mo+=${st.positiveMonths}/${st.totalMonths}`
    );
  }

  console.log('\n=== 2. universe split at the deployed 1.0% threshold ===');
  console.log('   Does the edge exist outside the 12 names the live bot already trades?\n');
  for (const [label, syms] of Object.entries({
    'all 56': universe,
    'overnight-drift own 12': universe.filter((p) => OV12.has(p.symbol)),
    'other 44 (unseen)': universe.filter((p) => !OV12.has(p.symbol)),
  })) {
    const sigs = [];
    for (const S of syms) sigs.push(...signals(S, 0.010));
    const st = score(sigs);
    if (!st) { console.log(`  ${label}: none`); continue; }
    console.log(`  ${label.padEnd(24)} n=${String(st.n).padStart(5)} exp=${st.expBp.toFixed(1).padStart(6)}bp ` +
      `win%=${st.winRatePct.toFixed(1)} IS=${st.isExpBp.toFixed(1).padStart(6)} OOS=${st.oosExpBp.toFixed(1).padStart(6)} ` +
      `mo+=${st.positiveMonths}/${st.totalMonths}`);
  }

  console.log('\n=== 3. cost sensitivity (all 56) ===');
  console.log('   Overnight holds cross the spread twice AND absorb the opening auction.\n');
  for (const th of THRESHOLDS) {
    const line = [0, 2, 5, 10].map((c) => `${c}bp:${score(cacheSigs.get(th), c).expBp.toFixed(1).padStart(6)}`).join('  ');
    console.log(`  >=${(th * 100).toFixed(1)}%  ${line}`);
  }

  console.log('\n=== 4. account simulation ($1000 start, 5bp cost, whole shares) ===');
  for (const th of [0.010, 0.015, 0.020]) {
    for (const riskPct of [0.15, 0.25]) {
      for (const maxC of [3, 5]) {
        const r = simulateAccount(cacheSigs.get(th), { maxConcurrent: maxC, riskPct, costBp: 5 });
        console.log(`  th=${(th * 100).toFixed(1)}% risk=${(riskPct * 100).toFixed(0)}% max${maxC} -> ` +
          `$${r.finalEquity.toFixed(0).padStart(6)} (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%) ` +
          `maxDD=${r.maxDdPct.toFixed(1).padStart(5)}% trades=${String(r.trades).padStart(4)} win%=${r.winRatePct.toFixed(1)}`);
      }
    }
  }

  const best = score(cacheSigs.get(0.010), 5);
  console.log(`\n=== 5. monthly, all 56, th=1.0%, 5bp cost (exp ${best.expBp.toFixed(1)}bp, IS ${best.isExpBp.toFixed(1)}, OOS ${best.oosExpBp.toFixed(1)}) ===`);
  console.log('  ' + best.months.map((m) => `${m.month.slice(2)}:${m.expBp.toFixed(0)}`).join('  '));
  console.log(`  positive months=${best.positiveMonths}/${best.totalMonths}  worst trade=${best.worstPct.toFixed(1)}%  1st pctile=${best.p1Pct.toFixed(1)}%`);
}

main();
