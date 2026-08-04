// Optimises ORB-15's ratcheting profit floor (RATCHET_STEP_PCT x RATCHET_STOP_PCT) on
// REAL option bars, using the same contract-resolution machinery as sweep9-stoptarget-grid.js:
// resolve each signal's contract once, then simulate every (step, trail) pair in-memory.
//
// ORB's ratchet is ADDITIVE (minStopRung: 1 in runner.js) - rung 0 has no stop of its own,
// so the existing validated exits (OPTION_STOP_PCT catastrophic backstop, or_mid_stop,
// EOD flatten) are simulated unchanged underneath it and the ratchet can only ever close a
// trade that is already up at least one full step. That means the control row here is
// literally "the current bot", and any difference is attributable to the ratchet alone.
//
// Optimisation target is DOWNSIDE: max drawdown, loss rate, average loss, worst trade.
//
// Usage: node --env-file=.env scripts/orb-ratchet-sweep.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const ratchet = require('../lib/ratchet');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30';
const FLATTEN = '15:45';
const ZERO_DTE_SYMBOLS = new Set(['SPY', 'QQQ']);

const STEP_GRID = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
const TRAIL_GRID = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];

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
  const add = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}
function occDate(dayStr) { return dayStr.slice(2).replace(/-/g, ''); }
function buildOccSymbol(root, expDate, type, strike) {
  return `${root}${occDate(expDate)}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

async function findHistoricalContract(symbol, day, direction, underlyingPrice) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const expDate = ZERO_DTE_SYMBOLS.has(symbol) ? day : nextFridayOnOrAfter(day);
  const dayStart = `${day}T00:00:00Z`;
  const dayEnd = `${day}T23:59:59Z`;
  const increments = underlyingPrice < 50 ? [1, 2.5, 0.5] : underlyingPrice < 300 ? [2.5, 5, 1] : [5, 2.5, 10];
  const candidates = new Set();
  for (const inc of increments) {
    const base = Math.round(underlyingPrice / inc) * inc;
    for (const off of [0, -1, 1, -2, 2]) candidates.add(+(base + off * inc).toFixed(2));
  }
  let best = null;
  for (const strike of candidates) {
    if (strike <= 0) continue;
    const occ = buildOccSymbol(symbol, expDate, type, strike);
    const bars = await getOptionBars(occ, dayStart, dayEnd);
    if (bars.length === 0) continue;
    const diff = Math.abs(strike - underlyingPrice);
    if (!best || diff < best.diff) best = { occ, strike, diff, bars };
  }
  return best;
}

// One trade. `step`/`trail` null = control (current bot, no ratchet).
// Per-bar order is deliberately adverse-first, matching sweep9's treatment: catastrophic
// stop, then the ratchet's trailing stop (only armed from rung 1), then ratchet advance on
// the high, then or_mid_stop on the underlying. With only OHLC we cannot know intrabar
// sequence, so every ambiguous bar resolves against the strategy.
function simulate(sig, step, trail, maxRungs) {
  const { optionBars, optParts, uByTime, entryIdx, orMid, isBull } = sig;
  const entryPremium = optionBars[entryIdx].o;
  if (!entryPremium || entryPremium <= 0) return null;

  let lastPremium = entryPremium;
  let rung = 0;
  for (let j = entryIdx; j < optionBars.length; j++) {
    const p = optParts[j];
    if (p.day !== sig.day) continue;
    if (p.time >= FLATTEN) break;
    const bar = optionBars[j];
    lastPremium = bar.c;
    if (j === entryIdx) continue;

    const lowGain = (bar.l - entryPremium) / entryPremium;
    const highGain = (bar.h - entryPremium) / entryPremium;

    // 1. catastrophic premium stop (unchanged from the deployed bot)
    if (lowGain <= -cfg.OPTION_STOP_PCT) return { r: -cfg.OPTION_STOP_PCT, exit: 'option_stop', rung };

    // 2. ratchet trailing stop - armed only from rung 1 (minStopRung: 1)
    if (step != null) {
      const { stop } = ratchet.levelsForRung(rung, step, trail);
      if (rung >= 1 && lowGain <= stop) return { r: stop, exit: 'trail_stop', rung };
      rung = ratchet.rungFor(rung, highGain, step, maxRungs);
    }

    // 3. primary validated exit: underlying crossed back through the OR midpoint
    const uBar = uByTime.get(p.time);
    if (uBar) {
      const crossed = isBull ? uBar.l <= orMid : uBar.h >= orMid;
      if (crossed) return { r: (lastPremium - entryPremium) / entryPremium, exit: 'or_mid_stop', rung };
    }
  }
  return { r: (lastPremium - entryPremium) / entryPremium, exit: 'eod', rung };
}

function maxDrawdown(rs) {
  let cum = 0, peak = 0, worst = 0;
  for (const r of rs) { cum += r; if (cum > peak) peak = cum; if (peak - cum > worst) worst = peak - cum; }
  return worst;
}

function stats(results) {
  const n = results.length;
  if (!n) return null;
  const chrono = results.slice().sort((a, b) => a.t - b.t);
  const rs = chrono.map((r) => r.r);
  const tot = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const byMonth = new Map();
  for (const r of chrono) {
    const m = r.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r.r);
  }
  const months = [...byMonth.entries()].sort().map(([m, a]) => ({
    month: m, n: a.length, expBp: (a.reduce((x, y) => x + y, 0) / a.length) * 10000,
  }));
  return {
    n,
    expBp: (tot / n) * 10000,
    totPct: tot * 100,
    winRatePct: (wins.length / n) * 100,
    lossRatePct: (losses.length / n) * 100,
    avgLossPct: (losses.reduce((a, b) => a + b, 0) / (losses.length || 1)) * 100,
    worstTradePct: Math.min(...rs) * 100,
    maxDdPct: maxDrawdown(rs) * 100,
    positiveMonths: months.filter((m) => m.expBp > 0).length,
    totalMonths: months.length,
    months,
    exits: results.reduce((a, r) => { a[r.exit] = (a[r.exit] || 0) + 1; return a; }, {}),
    avgRung: results.reduce((a, r) => a + (r.rung || 0), 0) / n,
  };
}

function line(label, s) {
  return `${label.padEnd(24)} n=${String(s.n).padStart(4)} exp=${s.expBp.toFixed(0).padStart(6)}bp ` +
    `maxDD=${s.maxDdPct.toFixed(0).padStart(5)}% lossRate=${s.lossRatePct.toFixed(1).padStart(5)}% ` +
    `avgLoss=${s.avgLossPct.toFixed(1).padStart(7)}% worst=${s.worstTradePct.toFixed(0).padStart(5)}% ` +
    `tot=${s.totPct.toFixed(0).padStart(6)}% mo+=${s.positiveMonths}/${s.totalMonths}`;
}

async function main() {
  const days = parseInt(process.argv[2] || '120', 10);
  console.log(`Fetching ${days} days of underlying bars for ${SYMBOLS.length} symbols...`);
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

  // ORB breakout signals, same rules as the live bot
  const raw = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const orBars = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time >= '09:30' && parts[i].time < '09:45') orBars.push(bars[i]);
      }
      if (orBars.length < OR_MINUTES / 5) continue;
      const orHigh = Math.max(...orBars.map((b) => b.h));
      const orLow = Math.min(...orBars.map((b) => b.l));
      const orMid = (orHigh + orLow) / 2;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:45' || parts[i].time >= CUTOFF) continue;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        if (bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const bull = bars[i].c > orHigh;
        const bear = bars[i].c < orLow;
        if (!bull && !bear) continue;
        raw.push({ symbol, day, time: parts[i].time, orMid, isBull: bull, price: bars[i].c, bars, parts, dayIndex, t: new Date(bars[i].t).getTime() });
        break; // one ORB attempt per symbol per day, like the bot
      }
    }
  }
  console.log(`${raw.length} raw ORB signals. Resolving real option contracts (slow, once)...`);

  const signals = [];
  let resolved = 0;
  for (const s of raw) {
    const c = await findHistoricalContract(s.symbol, s.day, s.isBull ? 'bullish' : 'bearish', s.price);
    if (!c) continue;
    const optParts = c.bars.map(etParts);
    let entryIdx = -1;
    for (let j = 0; j < c.bars.length; j++) {
      if (optParts[j].day === s.day && optParts[j].time >= s.time) { entryIdx = j; break; }
    }
    if (entryIdx < 0) continue;
    const uByTime = new Map();
    const di = s.dayIndex.get(s.day);
    for (let i = di.firstIdx; i <= di.lastIdx; i++) uByTime.set(s.parts[i].time, s.bars[i]);
    signals.push({ ...s, optionBars: c.bars, optParts, entryIdx, uByTime });
    resolved++;
    if (resolved % 25 === 0) console.log(`  resolved ${resolved}...`);
  }
  console.log(`${signals.length} signals with usable option bars.\n`);
  if (signals.length === 0) return;

  const MAXR = cfg.RATCHET_MAX_RUNGS || 100;
  const run = (step, trail) => stats(signals.map((s) => {
    const r = simulate(s, step, trail, MAXR);
    return r && { day: s.day, t: s.t, ...r };
  }).filter(Boolean));

  console.log('=== CONTROL: current bot, ratchet OFF ===');
  const baseline = run(null, null);
  console.log(line('NO RATCHET', baseline));
  console.log(`   exits=${JSON.stringify(baseline.exits)}\n`);

  console.log('=== RATCHET grid (additive; rung 0 has no stop) ===');
  const rows = [];
  for (const step of STEP_GRID) {
    for (const trail of TRAIL_GRID) {
      const s = run(step, trail);
      s.step = step; s.trail = trail;
      rows.push(s);
      console.log(line(`step=${(step * 100).toFixed(0)}% trail=${(trail * 100).toFixed(0)}%`, s));
    }
  }

  const deployed = rows.find((r) => r.step === cfg.RATCHET_STEP_PCT && r.trail === cfg.RATCHET_STOP_PCT);
  const viable = rows.filter((r) => r.expBp > 0 && r.totPct > 0);
  const byDd = viable.slice().sort((a, b) => a.maxDdPct - b.maxDdPct);
  const byExp = rows.slice().sort((a, b) => b.expBp - a.expBp);

  console.log('\n=== RESULTS ===');
  console.log(line('CONTROL (ratchet off)', baseline));
  if (deployed) console.log(line(`DEPLOYED step=${(cfg.RATCHET_STEP_PCT * 100).toFixed(0)}% trail=${(cfg.RATCHET_STOP_PCT * 100).toFixed(0)}%`, deployed));
  console.log(`\nViable (positive exp + positive total): ${viable.length}/${rows.length}`);
  console.log('\nLowest max drawdown among viable:');
  for (const r of byDd.slice(0, 6)) console.log('  ' + line(`step=${(r.step * 100).toFixed(0)}% trail=${(r.trail * 100).toFixed(0)}%`, r));
  console.log('\nHighest expectancy overall:');
  for (const r of byExp.slice(0, 6)) console.log('  ' + line(`step=${(r.step * 100).toFixed(0)}% trail=${(r.trail * 100).toFixed(0)}%`, r));

  const pick = byDd[0];
  if (pick) {
    console.log(`\n=== MIN-DRAWDOWN PICK: step=${(pick.step * 100).toFixed(0)}% trail=${(pick.trail * 100).toFixed(0)}% ===`);
    console.log(`  exits=${JSON.stringify(pick.exits)} avgRung=${pick.avgRung.toFixed(2)}`);
    console.log('  vs CONTROL: ' +
      `maxDD ${baseline.maxDdPct.toFixed(0)}% -> ${pick.maxDdPct.toFixed(0)}% | ` +
      `lossRate ${baseline.lossRatePct.toFixed(1)}% -> ${pick.lossRatePct.toFixed(1)}% | ` +
      `avgLoss ${baseline.avgLossPct.toFixed(1)}% -> ${pick.avgLossPct.toFixed(1)}% | ` +
      `exp ${baseline.expBp.toFixed(0)} -> ${pick.expBp.toFixed(0)}bp`);
    for (const m of pick.months) console.log(`    ${m.month}: n=${String(m.n).padStart(3)} exp=${m.expBp.toFixed(0)}bp`);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
