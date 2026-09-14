// Replacement search for swing-signals, which measured out at 18 trades/YEAR at +0.1bp
// (scripts/strategy-swing-signalrate-sweep.js). That bot's account is a plain SHARES
// account, so candidates here are long-only equity strategies - no contract selection, no
// affordability friction, exact sizing on a $1,000 account.
//
// Six structurally DIFFERENT mechanisms are tested, not six tunings of one idea. The
// failure mode being avoided is the one that killed swing-signals: a signal that backtests
// well on bars the live bot can never act on. Every candidate here is therefore evaluated
// only on entries inside a tradeable window, one entry per symbol per day, long only,
// flat by 15:45 - i.e. exactly what a runner could execute.
//
// Standards, fixed BEFORE looking at any result (same bar the rest of this project uses):
//   n >= 200                        - the project's standing evidentiary bar
//   >= 100 trades/year              - swing-signals' actual defect was never trading
//   in-sample AND out-of-sample expectancy both > 0, on a chronological 70/30 split
//   >= 50% of months positive
//   expectancy > 5bp                - must clear plausible round-trip cost, not just zero
// 12 candidate/exit combinations are scored, so some rows will look good by luck alone;
// the IS/OOS split is what separates those out. "Nothing qualifies" is a valid result.
//
// Bars are cached to logs/ on first run (the fetch is the slow part, ~15 min) so re-runs
// are fast. Delete the cache file to force a refetch.
//
// Usage: node --env-file=.env scripts/strategy-replacement-screen.js [days]
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { ema } = require('../lib/indicators');
const watchlist = require('../lib/watchlist');

const TIMEFRAME = '5Min';
const BENCH = 'SPY';
const EXIT_TIME = '15:45';       // every bot in this project flattens here
const CACHE = path.join(__dirname, '..', 'logs', 'bars-cache-5min.json');

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let all = [];
  let pageToken = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: {
        symbols: symbol, timeframe: TIMEFRAME, start, limit: 10000,
        adjustment: 'split', feed: 'iex', page_token: pageToken || undefined,
      },
    });
    all = all.concat(res.bars[symbol] || []);
    pageToken = res.next_page_token;
  } while (pageToken);
  return all;
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

async function loadData(days) {
  if (fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cached.days === days) {
      console.log(`Using cached bars (${cached.symbols.length} symbols, fetched ${cached.fetchedAt}).`);
      return cached.symbols;
    }
  }
  console.log(`Fetching ${days} days of ${TIMEFRAME} bars for ${watchlist.length} symbols + ${BENCH}...`);
  const symbols = [];
  for (const symbol of [...new Set([...watchlist, BENCH])]) {
    try {
      const bars = await getHistoricalBars(symbol, days);
      if (bars.length < 300) { console.log(`  ${symbol}: only ${bars.length} bars - skipped`); continue; }
      symbols.push({ symbol, bars: bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) });
    } catch (e) { console.log(`  ${symbol}: fetch failed (${e.message}) - skipped`); }
  }
  fs.writeFileSync(CACHE, JSON.stringify({ days, fetchedAt: new Date().toISOString(), symbols }));
  console.log(`Cached to ${CACHE}`);
  return symbols;
}

// Per-symbol derived series: ET parts, session day index, VWAP, EMA(50), day open/prev close.
function prepare(entry) {
  const { symbol, bars } = entry;
  const parts = bars.map(etParts);
  const closes = bars.map((b) => b.c);
  const ema50 = ema(closes, 50);

  const days = new Map(); // day -> { idxs:[], openIdx, openPrice, prevClose }
  for (let i = 0; i < bars.length; i++) {
    const { day, time } = parts[i];
    if (time < '09:30' || time >= '16:00') continue; // regular session only
    if (!days.has(day)) days.set(day, { idxs: [], openIdx: i, openPrice: bars[i].o });
    days.get(day).idxs.push(i);
  }
  const dayList = [...days.keys()].sort();
  for (let d = 1; d < dayList.length; d++) {
    const prev = days.get(dayList[d - 1]);
    days.get(dayList[d]).prevClose = bars[prev.idxs[prev.idxs.length - 1]].c;
  }

  // Session VWAP, reset each day.
  const vwap = new Array(bars.length).fill(null);
  for (const day of dayList) {
    let pv = 0, vol = 0;
    for (const i of days.get(day).idxs) {
      const typical = (bars[i].h + bars[i].l + bars[i].c) / 3;
      pv += typical * (bars[i].v || 0);
      vol += bars[i].v || 0;
      vwap[i] = vol > 0 ? pv / vol : null;
    }
  }
  return { symbol, bars, parts, ema50, vwap, days, dayList };
}

// ---------------------------------------------------------------------------------------
// Exit regimes. Both are things a 60s-polling runner can actually execute.
// Stop-before-target on an ambiguous bar: with only OHLC we cannot know which came first,
// and assuming the adverse move landed first is the bias every sweep in this repo applies.
function simEod(S, entryIdx, day, entry) {
  let last = entry;
  for (let j = entryIdx + 1; j < S.bars.length; j++) {
    if (S.parts[j].day !== day) break;
    if (S.parts[j].time >= EXIT_TIME) break;
    last = S.bars[j].c;
  }
  return { r: (last - entry) / entry, reason: 'eod' };
}
function makeBracket(sl, tp) {
  return function simBracket(S, entryIdx, day, entry) {
    const slLevel = entry * (1 - sl), tpLevel = entry * (1 + tp);
    let last = entry;
    for (let j = entryIdx + 1; j < S.bars.length; j++) {
      if (S.parts[j].day !== day) break;
      if (S.parts[j].time >= EXIT_TIME) break;
      if (S.bars[j].l <= slLevel) return { r: -sl, reason: 'stop' };
      if (S.bars[j].h >= tpLevel) return { r: tp, reason: 'target' };
      last = S.bars[j].c;
    }
    return { r: (last - entry) / entry, reason: 'eod' };
  };
}

// ---------------------------------------------------------------------------------------
// Candidates. Each returns [{ day, entryIdx, entry }] - at most one per symbol per day.
// `bench` is the prepared SPY series, indexed by day+time for market-relative rules.

function benchReturnAt(bench, day, time) {
  const d = bench.days.get(day);
  if (!d) return null;
  let idx = null;
  for (const i of d.idxs) { if (bench.parts[i].time <= time) idx = i; else break; }
  if (idx === null) return null;
  return (bench.bars[idx].c - d.openPrice) / d.openPrice;
}

// A. Gap-down reversal: opened well below yesterday's close but still above trend.
function gapDownReversal(S, bench, gapPct) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    if (d.prevClose == null) continue;
    const gap = (d.openPrice - d.prevClose) / d.prevClose;
    if (gap > -gapPct) continue;
    const i = d.idxs.find((k) => S.parts[k].time >= '09:35');
    if (i == null || S.ema50[i] == null) continue;
    if (!(S.bars[i].c > S.ema50[i])) continue;
    out.push({ day, entryIdx: i, entry: S.bars[i].c });
  }
  return out;
}

// B. Gap-up continuation: opened well above yesterday's close, momentum holds.
function gapUpContinuation(S, bench, gapPct) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    if (d.prevClose == null) continue;
    const gap = (d.openPrice - d.prevClose) / d.prevClose;
    if (gap < gapPct) continue;
    const i = d.idxs.find((k) => S.parts[k].time >= '09:35');
    if (i == null || S.ema50[i] == null) continue;
    if (!(S.bars[i].c > S.ema50[i])) continue;
    out.push({ day, entryIdx: i, entry: S.bars[i].c });
  }
  return out;
}

// C. Relative strength at 10:00: leading the market by a clear margin since the open.
function relStrength(S, bench, edge) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    const i = d.idxs.find((k) => S.parts[k].time >= '10:00');
    if (i == null) continue;
    const mine = (S.bars[i].c - d.openPrice) / d.openPrice;
    const theirs = benchReturnAt(bench, day, S.parts[i].time);
    if (theirs === null) continue;
    if (mine - theirs < edge) continue;
    out.push({ day, entryIdx: i, entry: S.bars[i].c });
  }
  return out;
}

// D. Intraday dip-buy while the market itself is not falling.
function dipBuy(S, bench, dropPct) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    for (const i of d.idxs) {
      const t = S.parts[i].time;
      if (t < '10:00' || t >= '14:00') continue;
      const mine = (S.bars[i].c - d.openPrice) / d.openPrice;
      if (mine > -dropPct) continue;
      const theirs = benchReturnAt(bench, day, t);
      if (theirs === null || theirs < 0) continue;
      if (S.ema50[i] == null || !(S.bars[i].c > S.ema50[i])) continue;
      out.push({ day, entryIdx: i, entry: S.bars[i].c });
      break; // one per symbol per day
    }
  }
  return out;
}

// E. VWAP reclaim: crossed back above session VWAP after a morning below it.
function vwapReclaim(S, bench) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    let wasBelow = false;
    for (const i of d.idxs) {
      const t = S.parts[i].time;
      if (S.vwap[i] == null) continue;
      if (t < '10:00') { if (S.bars[i].c < S.vwap[i]) wasBelow = true; continue; }
      if (t >= '15:00') break;
      if (!wasBelow) break;
      if (S.bars[i].c > S.vwap[i] && S.ema50[i] != null && S.bars[i].c > S.ema50[i]) {
        out.push({ day, entryIdx: i, entry: S.bars[i].c });
        break;
      }
    }
  }
  return out;
}

// F. Power hour: strong on the day and above VWAP at 15:00, ride into the flatten.
function powerHour(S, bench, minGain) {
  const out = [];
  for (const day of S.dayList) {
    const d = S.days.get(day);
    const i = d.idxs.find((k) => S.parts[k].time >= '15:00');
    if (i == null || S.vwap[i] == null) continue;
    const mine = (S.bars[i].c - d.openPrice) / d.openPrice;
    if (mine < minGain) continue;
    if (!(S.bars[i].c > S.vwap[i])) continue;
    out.push({ day, entryIdx: i, entry: S.bars[i].c });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
function maxDrawdown(rs) {
  let cum = 0, peak = 0, worst = 0;
  for (const r of rs) { cum += r; if (cum > peak) peak = cum; if (peak - cum > worst) worst = peak - cum; }
  return worst;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  const chrono = trades.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const rs = chrono.map((x) => x.r);
  const tot = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  const byMonth = new Map();
  for (const x of chrono) {
    const m = x.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(x.r);
  }
  const months = [...byMonth.entries()].sort()
    .map(([m, arr]) => ({ month: m, n: arr.length, expBp: (arr.reduce((a, b) => a + b, 0) / arr.length) * 10000 }));
  const cut = Math.floor(n * 0.7);
  const isRs = rs.slice(0, cut), oosRs = rs.slice(cut);
  return {
    n, expBp: (tot / n) * 10000, totPct: tot * 100,
    winRatePct: (wins.length / n) * 100,
    maxDdPct: maxDrawdown(rs) * 100,
    worstTradePct: Math.min(...rs) * 100,
    isExpBp: isRs.length ? (isRs.reduce((a, b) => a + b, 0) / isRs.length) * 10000 : 0,
    oosExpBp: oosRs.length ? (oosRs.reduce((a, b) => a + b, 0) / oosRs.length) * 10000 : 0,
    oosN: oosRs.length,
    positiveMonths: months.filter((m) => m.expBp > 0).length,
    totalMonths: months.length,
    months,
    exits: trades.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {}),
  };
}

async function main() {
  const days = parseInt(process.argv[2] || '365', 10);
  const raw = await loadData(days);
  const prepared = raw.map(prepare);
  const bench = prepared.find((p) => p.symbol === BENCH);
  if (!bench) { console.error('no benchmark data'); return; }
  const universe = prepared.filter((p) => p.symbol !== BENCH);
  const tradingDays = new Set(universe.flatMap((p) => p.dayList)).size;
  console.log(`\n${universe.length} symbols, ${tradingDays} trading days.\n`);

  const CANDIDATES = [
    { key: 'A gap-down reversal 1.5%', fn: (S) => gapDownReversal(S, bench, 0.015) },
    { key: 'B gap-up continuation 1.5%', fn: (S) => gapUpContinuation(S, bench, 0.015) },
    { key: 'C rel-strength vs SPY 1.0%', fn: (S) => relStrength(S, bench, 0.010) },
    { key: 'D dip-buy 2.0% (SPY up)', fn: (S) => dipBuy(S, bench, 0.020) },
    { key: 'E VWAP reclaim', fn: (S) => vwapReclaim(S, bench) },
    { key: 'F power hour 1.0%', fn: (S) => powerHour(S, bench, 0.010) },
  ];
  const EXITS = [
    { key: 'EOD hold', sim: simEod },
    { key: 'bracket 1.5/2.0', sim: makeBracket(0.015, 0.020) },
  ];

  const rows = [];
  for (const c of CANDIDATES) {
    const signals = [];
    for (const S of universe) for (const s of c.fn(S)) signals.push({ S, ...s });
    for (const e of EXITS) {
      const trades = signals.map(({ S, day, entryIdx, entry }) => ({ day, ...e.sim(S, entryIdx, day, entry) }));
      const st = stats(trades);
      if (!st) { console.log(`${c.key.padEnd(28)} ${e.key.padEnd(16)} no signals`); continue; }
      const perYear = (st.n / tradingDays) * 252;
      rows.push({ candidate: c.key, exit: e.key, st, perYear });
      console.log(
        `${c.key.padEnd(28)} ${e.key.padEnd(16)} n=${String(st.n).padStart(5)} rate=${perYear.toFixed(0).padStart(5)}/yr ` +
        `exp=${st.expBp.toFixed(1).padStart(7)}bp win%=${st.winRatePct.toFixed(1).padStart(4)} ` +
        `maxDD=${st.maxDdPct.toFixed(1).padStart(6)}% mo+=${String(st.positiveMonths).padStart(2)}/${st.totalMonths} ` +
        `IS=${st.isExpBp.toFixed(1).padStart(7)} OOS=${st.oosExpBp.toFixed(1).padStart(7)}bp(n=${st.oosN})`
      );
    }
  }

  console.log(`\n=== qualifying (n>=200, >=100/yr, exp>5bp, IS>0, OOS>0, >=50% months up) ===`);
  console.log(`    ${rows.length} combinations scored - expect ~1 false positive by chance alone.\n`);
  const qualified = rows.filter((r) => r.st.n >= 200 && r.perYear >= 100 && r.st.expBp > 5
    && r.st.isExpBp > 0 && r.st.oosExpBp > 0 && r.st.positiveMonths / r.st.totalMonths >= 0.5);

  if (!qualified.length) {
    console.log('  NONE. No candidate clears the bar - do not deploy anything from this run.');
  } else {
    for (const r of qualified.sort((a, b) => b.st.expBp - a.st.expBp)) {
      console.log(`  ${r.candidate} / ${r.exit}`);
      console.log(`    n=${r.st.n} rate=${r.perYear.toFixed(0)}/yr exp=${r.st.expBp.toFixed(2)}bp win%=${r.st.winRatePct.toFixed(1)} ` +
        `IS=${r.st.isExpBp.toFixed(1)} OOS=${r.st.oosExpBp.toFixed(1)}bp maxDD=${r.st.maxDdPct.toFixed(1)}% ` +
        `worst=${r.st.worstTradePct.toFixed(1)}% mo+=${r.st.positiveMonths}/${r.st.totalMonths}`);
      console.log(`    exits=${JSON.stringify(r.st.exits)}`);
      console.log('    monthly: ' + r.st.months.map((m) => `${m.month}:${m.expBp.toFixed(0)}`).join(' '));
    }
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
