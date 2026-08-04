// Optimises the RATCHETING stop/target (lib/ratchet.js) on the deployed swing-signals
// entry rule (price > EMA(50) + RSI(14) crossing up through 30), on the same 56-symbol
// watchlist, same 5-min IEX bars, and same first-hit bar-walking discipline that
// scripts/strategy-swing-sweep.js used to validate the current fixed 1.5%/2.0% bracket.
// The two are directly comparable: the FIXED baseline is re-run here on the identical
// signal set, so every ratchet number has a like-for-like control.
//
// Optimisation target is DOWNSIDE, not expectancy: max drawdown on the equity curve,
// loss rate, average loss, worst trade, worst month. Expectancy is still reported because
// a strategy that loses less by trading worse is not an improvement - "lose as little as
// possible" is trivially won by not trading at all, so a combo must stay clearly
// profitable to be a candidate.
//
// Imports the REAL lib/ratchet.js the bots run, so this measures the deployed level math
// rather than a second implementation of it that could silently disagree.
//
// Usage: node --env-file=.env scripts/strategy-swing-ratchet-sweep.js [days]
const client = require('../lib/alpacaClient');
const { ema, rsi } = require('../lib/indicators');
const cfg = require('../lib/config');
const watchlist = require('../lib/watchlist');
const ratchet = require('../lib/ratchet');

const EMA_TREND = 50;
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;
const EXIT_TIME = '15:45';

// step = how far price must run to earn a rung; stopDist = how far the stop trails below
// the last target reached. Deployed setting is step 0.02 / stopDist 0.015.
const STEP_GRID = [0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05];
const STOPDIST_GRID = [0.005, 0.0075, 0.01, 0.015, 0.02, 0.025, 0.03];

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

// Fixed bracket - the currently deployed behaviour, reproduced exactly as
// strategy-swing-sweep.js modelled it. Control group.
function simFixed(bars, parts, i, day, entry, tp, sl) {
  const tpLevel = entry * (1 + tp);
  const slLevel = entry * (1 - sl);
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= EXIT_TIME) break;
    if (bars[j].l <= slLevel) return { r: -sl, reason: 'stop' };
    if (bars[j].h >= tpLevel) return { r: tp, reason: 'target' };
    lastClose = bars[j].c;
  }
  return { r: (lastClose - entry) / entry, reason: 'eod' };
}

// Ratcheting bracket. Per bar, in this order:
//   1. stop check against the CURRENT rung's stop, using the bar low
//   2. ratchet up using the bar high
// Stop-before-target is the conservative reading of an ambiguous bar: with only OHLC we
// cannot know whether the low or the high came first, and assuming the adverse move landed
// first is the same bias simFixed (and the original sweep) already applies. It matters more
// here because a ratchet can traverse several rungs inside one bar, so the optimistic
// reading would manufacture free upside that the live bot - which only ever sees discrete
// 5-min polls - could never actually capture.
function simRatchet(bars, parts, i, day, entry, step, stopDist, maxRungs) {
  let rung = 0;
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= EXIT_TIME) break;

    const { stop } = ratchet.levelsForRung(rung, step, stopDist);
    const lowGain = (bars[j].l - entry) / entry;
    if (lowGain <= stop) {
      return { r: stop, reason: rung > 0 ? 'trail_stop' : 'stop', rung };
    }
    const highGain = (bars[j].h - entry) / entry;
    rung = ratchet.rungFor(rung, highGain, step, maxRungs);
    lastClose = bars[j].c;
  }
  return { r: (lastClose - entry) / entry, reason: 'eod', rung };
}

// Max peak-to-trough drawdown of the cumulative per-trade return curve, trades taken in
// chronological order and equally weighted. This is the headline "how much do I lose"
// number - a strategy can have a fine average and still be unholdable.
function maxDrawdown(sortedReturns) {
  let cum = 0, peak = 0, worst = 0;
  for (const r of sortedReturns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > worst) worst = dd;
  }
  return worst;
}

function stats(results) {
  const n = results.length;
  if (!n) return null;
  const chrono = results.slice().sort((a, b) => a.t - b.t);
  const rs = chrono.map((r) => r.r);
  const tot = rs.reduce((a, b) => a + b, 0);
  const losses = rs.filter((r) => r <= 0);
  const wins = rs.filter((r) => r > 0);

  const byMonth = new Map();
  for (const r of chrono) {
    const m = r.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r.r);
  }
  const months = [...byMonth.entries()].sort().map(([m, arr]) => ({
    month: m, n: arr.length, expBp: (arr.reduce((a, b) => a + b, 0) / arr.length) * 10000,
  }));

  const exits = results.reduce((a, r) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {});

  return {
    n,
    expBp: (tot / n) * 10000,
    totPct: tot * 100,
    winRatePct: (wins.length / n) * 100,
    lossRatePct: (losses.length / n) * 100,
    avgWinPct: (wins.reduce((a, b) => a + b, 0) / (wins.length || 1)) * 100,
    avgLossPct: (losses.reduce((a, b) => a + b, 0) / (losses.length || 1)) * 100,
    worstTradePct: Math.min(...rs) * 100,
    maxDdPct: maxDrawdown(rs) * 100,
    worstMonthBp: months.length ? Math.min(...months.map((m) => m.expBp)) : 0,
    positiveMonths: months.filter((m) => m.expBp > 0).length,
    totalMonths: months.length,
    months,
    exits,
    avgRung: results.reduce((a, r) => a + (r.rung || 0), 0) / n,
  };
}

function line(label, s) {
  return `${label.padEnd(26)} n=${String(s.n).padStart(4)} exp=${s.expBp.toFixed(2).padStart(7)}bp ` +
    `maxDD=${s.maxDdPct.toFixed(2).padStart(6)}% lossRate=${s.lossRatePct.toFixed(1).padStart(4)}% ` +
    `avgLoss=${s.avgLossPct.toFixed(3).padStart(7)}% worst=${s.worstTradePct.toFixed(2).padStart(7)}% ` +
    `tot=${s.totPct.toFixed(1).padStart(7)}% mo+=${s.positiveMonths}/${s.totalMonths}`;
}

async function main() {
  const days = parseInt(process.argv[2] || '365', 10);
  console.log(`Fetching ${days} days of ${cfg.TIMEFRAME} bars for ${watchlist.length} symbols...`);
  const data = [];
  for (const symbol of watchlist) {
    let bars;
    try {
      bars = await getHistoricalBars(symbol, days);
    } catch (e) {
      console.log(`${symbol}: fetch failed (${e.message}) - skipped`);
      continue;
    }
    if (bars.length < 300) { console.log(`${symbol}: only ${bars.length} bars - skipped`); continue; }
    data.push({ symbol, bars, parts: bars.map(etParts) });
  }
  console.log(`${data.length} symbols usable.\n`);

  // Signal set is built ONCE and shared by every combo, so all rows below differ only in
  // exit handling - never in which trades were taken.
  const signals = [];
  for (const { symbol, bars, parts } of data) {
    const closes = bars.map((b) => b.c);
    const trendEma = ema(closes, EMA_TREND);
    const rsiVals = rsi(closes, RSI_PERIOD);
    const warmup = Math.max(EMA_TREND, RSI_PERIOD) + 2;
    for (let i = warmup; i < bars.length - 1; i++) {
      if (parts[i].time >= EXIT_TIME) continue;
      if (parts[i].time < '09:45') continue; // ENTRY_WINDOW_START
      if (parts[i].time >= '15:30') continue; // ENTRY_WINDOW_END
      if (trendEma[i] == null || rsiVals[i - 1] == null || rsiVals[i] == null) continue;
      if (!(closes[i] > trendEma[i])) continue;
      if (!(rsiVals[i - 1] <= RSI_OVERSOLD && rsiVals[i] > RSI_OVERSOLD)) continue;
      signals.push({ symbol, day: parts[i].day, t: new Date(bars[i].t).getTime(), i, price: closes[i], bars, parts });
    }
  }
  console.log(`${signals.length} raw entry signals across the sample.\n`);
  if (signals.length === 0) return;

  const MAXR = cfg.RATCHET_MAX_RUNGS || 100;

  console.log('=== CONTROL: fixed bracket (what is validated / what ratchet replaces) ===');
  const baseline = stats(signals.map((s) => ({
    day: s.day, t: s.t, ...simFixed(s.bars, s.parts, s.i, s.day, s.price, 0.02, 0.015),
  })));
  console.log(line('FIXED sl=1.5% tp=2.0%', baseline), '<- DEPLOYED BASELINE');
  console.log(`   exits=${JSON.stringify(baseline.exits)}\n`);

  console.log('=== RATCHET grid ===');
  const rows = [];
  for (const step of STEP_GRID) {
    for (const stopDist of STOPDIST_GRID) {
      const s = stats(signals.map((sig) => ({
        day: sig.day, t: sig.t,
        ...simRatchet(sig.bars, sig.parts, sig.i, sig.day, sig.price, step, stopDist, MAXR),
      })));
      s.step = step; s.stopDist = stopDist;
      rows.push(s);
      console.log(line(`step=${(step * 100).toFixed(2)}% trail=${(stopDist * 100).toFixed(2)}%`, s));
    }
  }

  const deployed = rows.find((r) => r.step === 0.02 && r.stopDist === 0.015);

  // Candidate filter: must still be a strategy worth running. Anything that "loses less"
  // by giving up the edge is excluded rather than presented as an optimisation.
  const viable = rows.filter((r) => r.expBp > 0 && r.totPct > 0 && r.positiveMonths / r.totalMonths >= 0.5);

  const byDd = viable.slice().sort((a, b) => a.maxDdPct - b.maxDdPct);
  const byExp = rows.slice().sort((a, b) => b.expBp - a.expBp);
  const byLoss = viable.slice().sort((a, b) => a.lossRatePct - b.lossRatePct);

  console.log('\n=== RESULTS ===');
  console.log(line('CONTROL fixed 1.5/2.0', baseline));
  if (deployed) console.log(line('RATCHET as deployed', deployed));
  console.log(`\nViable combos (positive expectancy + positive total + >=50% months up): ${viable.length}/${rows.length}`);
  if (byDd.length) {
    console.log('\nLowest max drawdown among viable:');
    for (const r of byDd.slice(0, 5)) console.log('  ' + line(`step=${(r.step * 100).toFixed(2)}% trail=${(r.stopDist * 100).toFixed(2)}%`, r));
    console.log('\nLowest loss rate among viable:');
    for (const r of byLoss.slice(0, 5)) console.log('  ' + line(`step=${(r.step * 100).toFixed(2)}% trail=${(r.stopDist * 100).toFixed(2)}%`, r));
  }
  console.log('\nHighest expectancy overall (for contrast - not the objective here):');
  for (const r of byExp.slice(0, 5)) console.log('  ' + line(`step=${(r.step * 100).toFixed(2)}% trail=${(r.stopDist * 100).toFixed(2)}%`, r));

  const pick = byDd[0];
  if (pick) {
    console.log(`\n=== RECOMMENDED (min drawdown among viable): step=${(pick.step * 100).toFixed(2)}% trail=${(pick.stopDist * 100).toFixed(2)}% ===`);
    console.log(line('  ', pick));
    console.log(`  exits=${JSON.stringify(pick.exits)} avgRungReached=${pick.avgRung.toFixed(2)}`);
    console.log('  vs CONTROL: ' +
      `maxDD ${baseline.maxDdPct.toFixed(2)}% -> ${pick.maxDdPct.toFixed(2)}% | ` +
      `lossRate ${baseline.lossRatePct.toFixed(1)}% -> ${pick.lossRatePct.toFixed(1)}% | ` +
      `avgLoss ${baseline.avgLossPct.toFixed(3)}% -> ${pick.avgLossPct.toFixed(3)}% | ` +
      `exp ${baseline.expBp.toFixed(2)} -> ${pick.expBp.toFixed(2)}bp`);
    console.log('  Monthly:');
    for (const m of pick.months) console.log(`    ${m.month}: n=${String(m.n).padStart(3)} exp=${m.expBp.toFixed(2)}bp`);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
