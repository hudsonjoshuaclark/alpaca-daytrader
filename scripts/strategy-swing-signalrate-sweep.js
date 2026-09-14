// Why this exists: swing-signals as deployed has taken ZERO trades in the 11 sessions since
// it went live, and its own config.js already documents why - only 5.5% of the validating
// n=324 signal set falls inside the live entry window (09:45-15:30 ET), because RSI(14)
// crossing up through 30 is overwhelmingly an at-the-open event. The bot should take ~19
// trades/YEAR. A strategy that never fires has no edge to harvest regardless of how good
// its backtest looked.
//
// This searches for a variant that produces a usable IN-WINDOW signal rate while still
// carrying a real edge. It only ever counts signals the live bot could actually act on -
// every combo is filtered by the same entry window the runner enforces, which is exactly
// what scripts/strategy-swing-sweep.js failed to do.
//
// Exits are simulated with the DEPLOYED ratchet (lib/ratchet.js, step 2.0% / trail 1.5%)
// so the numbers describe the live bot, with the fixed bracket reported alongside as a
// control. Bar-walking is stop-before-target on ambiguous bars, matching the discipline in
// scripts/strategy-swing-ratchet-sweep.js.
//
// Overfitting guard: 24 combos are scored, so the best in-sample row is expected to look
// good by luck alone. Every combo is therefore ALSO scored on a chronological 70/30 split -
// a variant is only a candidate if the out-of-sample third holds up on its own.
//
// Usage: node --env-file=.env scripts/strategy-swing-signalrate-sweep.js [days]
const client = require('../lib/alpacaClient');
const { ema, rsi } = require('../lib/indicators');
const watchlist = require('../lib/watchlist');
const ratchet = require('../lib/ratchet');

const TIMEFRAME = '5Min';
const RSI_PERIOD = 14;
const EXIT_TIME = '15:45';       // FORCE_CLOSE_AT
const WINDOW_END = '15:30';      // ENTRY_WINDOW_END, unchanged
const STEP = 0.02;               // deployed TAKE_PROFIT_PCT
const TRAIL = 0.015;             // deployed STOP_LOSS_PCT
const MAX_RUNGS = 100;

// The grid. Deployed setting is rsi=30, window=09:45, ema=50.
const RSI_GRID = [30, 35, 40, 45];
const WINDOW_GRID = ['09:35', '09:45', '10:00'];
const EMA_GRID = [50, 20];

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let allBars = [];
  let pageToken = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: {
        symbols: symbol, timeframe: TIMEFRAME, start, limit: 10000,
        adjustment: 'split', feed: 'iex', page_token: pageToken || undefined,
      },
    });
    allBars = allBars.concat(res.bars[symbol] || []);
    pageToken = res.next_page_token;
  } while (pageToken);
  return allBars;
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

function simRatchet(bars, parts, i, day, entry) {
  let rung = 0, lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= EXIT_TIME) break;
    const { stop } = ratchet.levelsForRung(rung, STEP, TRAIL);
    if ((bars[j].l - entry) / entry <= stop) return { r: stop, reason: rung > 0 ? 'trail_stop' : 'stop' };
    rung = ratchet.rungFor(rung, (bars[j].h - entry) / entry, STEP, MAX_RUNGS);
    lastClose = bars[j].c;
  }
  return { r: (lastClose - entry) / entry, reason: 'eod' };
}

function simFixed(bars, parts, i, day, entry) {
  const tpLevel = entry * (1 + STEP), slLevel = entry * (1 - TRAIL);
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= EXIT_TIME) break;
    if (bars[j].l <= slLevel) return { r: -TRAIL, reason: 'stop' };
    if (bars[j].h >= tpLevel) return { r: STEP, reason: 'target' };
    lastClose = bars[j].c;
  }
  return { r: (lastClose - entry) / entry, reason: 'eod' };
}

function maxDrawdown(rs) {
  let cum = 0, peak = 0, worst = 0;
  for (const r of rs) { cum += r; if (cum > peak) peak = cum; if (peak - cum > worst) worst = peak - cum; }
  return worst;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  const chrono = trades.slice().sort((a, b) => a.t - b.t);
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
  return {
    n, expBp: (tot / n) * 10000, totPct: tot * 100,
    winRatePct: (wins.length / n) * 100,
    maxDdPct: maxDrawdown(rs) * 100,
    worstTradePct: Math.min(...rs) * 100,
    positiveMonths: months.filter((m) => m.expBp > 0).length,
    totalMonths: months.length,
    months,
    exits: trades.reduce((a, x) => { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {}),
  };
}

// Chronological 70/30 split. In-sample picks the winner; out-of-sample is the honest test.
function split(trades) {
  const chrono = trades.slice().sort((a, b) => a.t - b.t);
  const cut = Math.floor(chrono.length * 0.7);
  return { is: stats(chrono.slice(0, cut)), oos: stats(chrono.slice(cut)) };
}

async function main() {
  const days = parseInt(process.argv[2] || '365', 10);
  console.log(`Fetching ${days} days of ${TIMEFRAME} bars for ${watchlist.length} symbols...`);
  const data = [];
  for (const symbol of watchlist) {
    try {
      const bars = await getHistoricalBars(symbol, days);
      if (bars.length < 300) { console.log(`  ${symbol}: only ${bars.length} bars - skipped`); continue; }
      data.push({ symbol, bars, parts: bars.map(etParts) });
    } catch (e) { console.log(`  ${symbol}: fetch failed (${e.message}) - skipped`); }
  }
  const tradingDays = new Set(data.flatMap((d) => d.parts.map((p) => p.day))).size;
  console.log(`${data.length} symbols usable, ${tradingDays} trading days in sample.\n`);

  // Pre-compute indicator series once per (symbol, emaLen).
  const series = new Map();
  for (const emaLen of EMA_GRID) {
    for (const d of data) {
      const closes = d.bars.map((b) => b.c);
      series.set(`${d.symbol}|${emaLen}`, { closes, trend: ema(closes, emaLen), rsiVals: rsi(closes, RSI_PERIOD) });
    }
  }

  // How the raw signal falls by time of day - the diagnosis this whole exercise rests on.
  console.log('=== signal time-of-day distribution (rsi=30, ema=50, the deployed rule) ===');
  const buckets = { '<09:30 pre': 0, '09:30-09:45 open': 0, '09:45-15:30 LIVE WINDOW': 0, '15:30-16:00 close': 0, '>=16:00 after': 0 };
  for (const d of data) {
    const { closes, trend, rsiVals } = series.get(`${d.symbol}|50`);
    for (let i = 52; i < d.bars.length - 1; i++) {
      if (trend[i] == null || rsiVals[i - 1] == null || rsiVals[i] == null) continue;
      if (!(closes[i] > trend[i])) continue;
      if (!(rsiVals[i - 1] <= 30 && rsiVals[i] > 30)) continue;
      const t = d.parts[i].time;
      if (t < '09:30') buckets['<09:30 pre']++;
      else if (t < '09:45') buckets['09:30-09:45 open']++;
      else if (t < '15:30') buckets['09:45-15:30 LIVE WINDOW']++;
      else if (t < '16:00') buckets['15:30-16:00 close']++;
      else buckets['>=16:00 after']++;
    }
  }
  const totalRaw = Object.values(buckets).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(26)} ${String(v).padStart(4)}  ${((v / totalRaw) * 100).toFixed(1)}%`);
  }
  console.log(`  total raw signals: ${totalRaw}\n`);

  console.log('=== grid: in-window signals only (what the live bot could actually take) ===');
  console.log('  rate = trades/year at this sample\'s pace. OOS = last 30% chronologically.\n');
  const rows = [];
  for (const emaLen of EMA_GRID) {
    for (const rsiT of RSI_GRID) {
      for (const winStart of WINDOW_GRID) {
        const trades = [], fixedTrades = [];
        for (const d of data) {
          const { closes, trend, rsiVals } = series.get(`${d.symbol}|${emaLen}`);
          const warmup = Math.max(emaLen, RSI_PERIOD) + 2;
          for (let i = warmup; i < d.bars.length - 1; i++) {
            const t = d.parts[i].time;
            if (t < winStart || t >= WINDOW_END) continue;
            if (trend[i] == null || rsiVals[i - 1] == null || rsiVals[i] == null) continue;
            if (!(closes[i] > trend[i])) continue;
            if (!(rsiVals[i - 1] <= rsiT && rsiVals[i] > rsiT)) continue;
            const meta = { day: d.parts[i].day, t: new Date(d.bars[i].t).getTime() };
            trades.push({ ...meta, ...simRatchet(d.bars, d.parts, i, d.parts[i].day, closes[i]) });
            fixedTrades.push({ ...meta, ...simFixed(d.bars, d.parts, i, d.parts[i].day, closes[i]) });
          }
        }
        const s = stats(trades);
        if (!s) { console.log(`  ema=${emaLen} rsi=${rsiT} win=${winStart}: no in-window signals`); continue; }
        const sp = split(trades);
        const f = stats(fixedTrades);
        const perYear = (s.n / tradingDays) * 252;
        const row = {
          emaLen, rsiT, winStart, s, f, perYear,
          oosExpBp: sp.oos ? sp.oos.expBp : null, oosN: sp.oos ? sp.oos.n : 0,
          isExpBp: sp.is ? sp.is.expBp : null,
        };
        rows.push(row);
        console.log(
          `  ema=${String(emaLen).padStart(2)} rsi=${rsiT} win=${winStart}  ` +
          `n=${String(s.n).padStart(4)} rate=${perYear.toFixed(0).padStart(4)}/yr  ` +
          `exp=${s.expBp.toFixed(1).padStart(7)}bp win%=${s.winRatePct.toFixed(1).padStart(4)}  ` +
          `maxDD=${s.maxDdPct.toFixed(1).padStart(6)}% mo+=${s.positiveMonths}/${s.totalMonths}  ` +
          `IS=${row.isExpBp.toFixed(1).padStart(7)} OOS=${row.oosExpBp === null ? '   n/a' : row.oosExpBp.toFixed(1).padStart(7)}bp(n=${row.oosN})  ` +
          `[fixed exp=${f.expBp.toFixed(1)}bp]`
        );
      }
    }
  }

  // Candidate bar, set BEFORE looking at the results:
  //  - enough trades to be a real strategy at all (>= 100/yr, ~1 every 2-3 sessions)
  //  - positive expectancy in-sample AND out-of-sample (survives the 70/30 split)
  //  - majority of months positive
  //  - n >= 200, this project's standing evidentiary bar
  console.log('\n=== candidates (>=100 trades/yr, n>=200, IS>0, OOS>0, >=50% months up) ===');
  const viable = rows.filter((r) => r.perYear >= 100 && r.s.n >= 200 && r.isExpBp > 0 && r.oosExpBp > 0
    && r.s.positiveMonths / r.s.totalMonths >= 0.5);
  if (!viable.length) {
    console.log('  NONE. No variant on this grid clears the bar - the honest answer is that this');
    console.log('  signal does not survive being restricted to the tradeable part of the day.');
  } else {
    for (const r of viable.sort((a, b) => b.oosExpBp - a.oosExpBp)) {
      console.log(`  ema=${r.emaLen} rsi=${r.rsiT} win=${r.winStart}  n=${r.s.n} rate=${r.perYear.toFixed(0)}/yr ` +
        `exp=${r.s.expBp.toFixed(1)}bp IS=${r.isExpBp.toFixed(1)} OOS=${r.oosExpBp.toFixed(1)}bp ` +
        `win%=${r.s.winRatePct.toFixed(1)} maxDD=${r.s.maxDdPct.toFixed(1)}% mo+=${r.s.positiveMonths}/${r.s.totalMonths}`);
    }
    const best = viable[0];
    console.log(`\n  BEST BY OOS: ema=${best.emaLen} rsi=${best.rsiT} win=${best.winStart}`);
    console.log(`  exits=${JSON.stringify(best.s.exits)}`);
    console.log('  monthly:');
    for (const m of best.s.months) console.log(`    ${m.month}: n=${String(m.n).padStart(3)} exp=${m.expBp.toFixed(1)}bp`);
  }

  const deployed = rows.find((r) => r.emaLen === 50 && r.rsiT === 30 && r.winStart === '09:45');
  if (deployed) {
    console.log(`\n=== DEPLOYED SETTING for reference: n=${deployed.s.n} rate=${deployed.perYear.toFixed(1)}/yr ` +
      `exp=${deployed.s.expBp.toFixed(1)}bp ===`);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
