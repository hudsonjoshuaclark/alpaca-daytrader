// Candidate strategy for a 4th bot: rule-based intraday SWING signals on the underlying
// stock itself (direct shares, not options) - several entries/day across a watchlist,
// each managed with a %-based stop-loss and take-profit bracket. Tests 3 long-only
// candidates against the same first-hit bracket engine used in sweep2.js (simBracket),
// x a stop/target grid, same evidentiary process as every other strategy in this repo.
//   A) RSI    — price above EMA(50) (trend filter) + RSI(14) crosses up through 30
//   B) MACD   — price above EMA(50) + MACD line crosses above its signal line
//   C) EMAVOL — EMA(9) crosses above EMA(21) with volume above its rolling average
//               (a volume-filtered variant of the EMA9/21 cross already rejected for
//               ORB-15's 1-min/options setup in sweep.js - kept in for completeness,
//               but treat a win here with real skepticism given that prior result)
// Usage: node --env-file=.env scripts/strategy-swing-sweep.js [days]
const client = require('../lib/alpacaClient');
const { ema, rsi, macd, rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const watchlist = require('../lib/watchlist');

const EMA_TREND = 50;
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;
const STOP_GRID = [0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06];
const TARGET_GRID = [0.02, 0.03, 0.04, 0.06, 0.08, 0.10, 0.12];
const EXIT_TIME = '15:45'; // same flatten discipline as every other bot - day trading, no overnight carry

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

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

// Same semantics as sweep2.js's simBracket - long-only here since all 3 candidates are long-only.
// Returns {r, reason} - reason lets us see whether the stop/target are actually the active
// exit mechanism intraday, or whether trades mostly just ride to the EOD flatten regardless
// (day-only hold, no overnight carry - matches every other bot's discipline).
function simBracket(bars, parts, i, day, entry, tp, sl, exitTime) {
  const tpLevel = entry * (1 + tp);
  const slLevel = entry * (1 - sl);
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= exitTime) break;
    const hitSL = bars[j].l <= slLevel;
    const hitTP = bars[j].h >= tpLevel;
    if (hitSL) return { r: -sl, reason: 'stop' };
    if (hitTP) return { r: tp, reason: 'target' };
    lastClose = bars[j].c;
  }
  return { r: (lastClose - entry) / entry, reason: 'eod' };
}

function report(name, results) {
  const n = results.length;
  if (!n) return { name, n: 0, line: `${name}: no trades` };
  const pnl = results.reduce((a, b) => a + b, 0);
  const wins = results.filter((r) => r > 0).length;
  const avgWin = results.filter((r) => r > 0).reduce((a, b) => a + b, 0) / (wins || 1);
  const avgLoss = results.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / ((n - wins) || 1);
  const expBp = (pnl / n) * 10000;
  const line = `${name}: n=${n} winRate=${((wins / n) * 100).toFixed(1)}% exp=${expBp.toFixed(2)}bp ` +
    `avgWin=${(avgWin * 100).toFixed(3)}% avgLoss=${(avgLoss * 100).toFixed(3)}% tot=${(pnl * 100).toFixed(2)}%`;
  return { name, n, expBp, winRate: wins / n, line };
}

// Per-month expectancy, to catch a lone-spike-month result the same way every other
// sweep script in this repo checks for it before trusting an aggregate number.
function monthlyStability(results, days) {
  const months = new Map();
  for (const r of results) {
    const m = r.day.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(r.r);
  }
  const rows = [...months.entries()].sort().map(([m, rs]) => {
    const pnl = rs.reduce((a, b) => a + b, 0);
    return { month: m, n: rs.length, expBp: (pnl / rs.length) * 10000 };
  });
  const positive = rows.filter((r) => r.expBp > 0).length;
  return { rows, positiveMonths: positive, totalMonths: rows.length };
}

async function main() {
  const days = parseInt(process.argv[2] || '180', 10);
  console.log(`Fetching ${days} days of ${cfg.TIMEFRAME} bars for ${watchlist.length} watchlist symbols...`);
  const data = [];
  for (const symbol of watchlist) {
    const bars = await getHistoricalBars(symbol, days);
    if (bars.length < 300) { console.log(`${symbol}: skipped, only ${bars.length} bars`); continue; }
    const parts = bars.map(etParts);
    data.push({ symbol, bars, parts });
    console.log(`${symbol}: ${bars.length} bars`);
  }

  const candidates = { A_RSI: [], B_MACD: [], C_EMAVOL: [] };

  for (const { symbol, bars, parts } of data) {
    const closes = bars.map((b) => b.c);
    const trendEma = ema(closes, EMA_TREND);
    const rsiVals = rsi(closes, RSI_PERIOD);
    const { macdLine, signalLine } = macd(closes);
    const emaFast = ema(closes, cfg.EMA_FAST);
    const emaSlow = ema(closes, cfg.EMA_SLOW);
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);

    const warmup = Math.max(EMA_TREND, RSI_PERIOD, 26 + 9, cfg.VOLUME_LOOKBACK) + 2;
    for (let i = warmup; i < bars.length - 1; i++) {
      if (parts[i].time >= EXIT_TIME) continue;
      const price = closes[i];
      const day = parts[i].day;

      // A) RSI pullback-in-trend
      if (trendEma[i] != null && rsiVals[i - 1] != null && rsiVals[i] != null) {
        const inUptrend = price > trendEma[i];
        const crossedUpThroughOversold = rsiVals[i - 1] <= RSI_OVERSOLD && rsiVals[i] > RSI_OVERSOLD;
        if (inUptrend && crossedUpThroughOversold) {
          candidates.A_RSI.push({ symbol, day, i, price, bars, parts });
        }
      }

      // B) MACD signal-line cross with trend filter
      if (trendEma[i] != null && macdLine[i - 1] != null && signalLine[i - 1] != null && macdLine[i] != null && signalLine[i] != null) {
        const inUptrend = price > trendEma[i];
        const crossedUp = macdLine[i - 1] <= signalLine[i - 1] && macdLine[i] > signalLine[i];
        if (inUptrend && crossedUp) {
          candidates.B_MACD.push({ symbol, day, i, price, bars, parts });
        }
      }

      // C) EMA9/21 crossover + volume filter
      if (emaFast[i - 1] != null && emaSlow[i - 1] != null && emaFast[i] != null && emaSlow[i] != null && avgVol[i] != null && avgVol[i] > 0) {
        const crossedUp = emaFast[i - 1] <= emaSlow[i - 1] && emaFast[i] > emaSlow[i];
        const rvol = bars[i].v / avgVol[i];
        if (crossedUp && rvol >= 1.5) {
          candidates.C_EMAVOL.push({ symbol, day, i, price, bars, parts });
        }
      }
    }
  }

  for (const [name, signals] of Object.entries(candidates)) {
    console.log(`\n=== Candidate ${name}: ${signals.length} raw signals ===`);
    let best = null;
    for (const sl of STOP_GRID) {
      for (const tp of TARGET_GRID) {
        const results = signals.map((s) => ({
          day: s.day,
          ...simBracket(s.bars, s.parts, s.i, s.day, s.price, tp, sl, EXIT_TIME),
        }));
        const rpt = report(`  sl=${(sl * 100).toFixed(1)}% tp=${(tp * 100).toFixed(1)}%`, results.map((r) => r.r));
        if (rpt.n > 0) {
          const exitCounts = results.reduce((a, r) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {});
          const activeRate = ((exitCounts.stop || 0) + (exitCounts.target || 0)) / rpt.n;
          console.log(`${rpt.line} exits=${JSON.stringify(exitCounts)} activeRate=${(activeRate * 100).toFixed(0)}%`);
          // Require the stop/target to actually be the dominant exit mechanism (>=50% of
          // trades resolved by one or the other, not just riding to the EOD flatten) - this
          // is what the user asked for: real stop-loss/take-profit discipline, not a mostly-
          // dormant safety net around a de-facto "hold to close" strategy. Among qualifying
          // combos, still pick highest expectancy.
          if (rpt.n >= 50 && activeRate >= 0.5 && (!best || rpt.expBp > best.expBp)) best = { ...rpt, sl, tp, results, activeRate };
        }
      }
    }
    if (best) {
      const stability = monthlyStability(best.results, days);
      const exitCounts = best.results.reduce((a, r) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {});
      console.log(`  BEST (n>=50, activeRate>=50%): sl=${(best.sl * 100).toFixed(1)}% tp=${(best.tp * 100).toFixed(1)}% -> ${best.line}`);
      console.log(`  Exit reasons: ${JSON.stringify(exitCounts)} activeRate=${(best.activeRate * 100).toFixed(0)}%`);
      console.log(`  Monthly: ${stability.positiveMonths}/${stability.totalMonths} months positive`);
      for (const row of stability.rows) console.log(`    ${row.month}: n=${row.n} exp=${row.expBp.toFixed(2)}bp`);
    } else {
      console.log('  No stop/target combo reached n>=50 trades with activeRate>=50% - insufficient sample or cutoffs rarely trigger.');
    }
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
