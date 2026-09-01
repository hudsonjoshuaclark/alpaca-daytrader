// Can ORB-15's measured UNDERLYING edge survive the friction of the option it is expressed in?
//
// This is the one arithmetic the repo has never done, and every other number depends on it.
//
// What is actually known, with power:
//   BACKTEST-BASELINE.md, n=603 underlying trades, 90 days: +8.1 bp/trade. That is the ONLY
//   figure in this repo measured on a low-variance distribution with a large sample. Every
//   options-level number (+2018bp, +3044bp, +2326bp) is that same edge multiplied by option
//   leverage, and inherits fat tails, ~10x the standard deviation, and far less power.
//
// So the question is not "is the options expectancy positive in the sim". It is:
//
//     underlying_edge x leverage   >   round-trip option friction ?
//
// Leverage is measured here rather than assumed, by pairing each cached real-option trade
// with the underlying's move over the SAME holding window and taking the ratio. Friction is
// then expressed in the same units so the two can be compared directly.
//
// Cache-only: contracts not already in logs/option-cache-orb.json are skipped, so this
// costs no contract-resolution API calls. Underlying bars are fetched (fast).
//
// Usage: node --env-file=.env scripts/orb-leverage-vs-friction.js [days]
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30';
const FLATTEN = '15:45';
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');

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

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  const days = parseInt(process.argv[2] || '240', 10);
  console.log(`ORB leverage vs friction | ${days} days | CACHE-ONLY\n`);

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

  const raw = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const orBars = [];
      for (let i = firstIdx; i <= lastIdx; i++) if (parts[i].time >= '09:30' && parts[i].time < '09:45') orBars.push(bars[i]);
      if (orBars.length < OR_MINUTES / 5) continue;
      const orHigh = Math.max(...orBars.map((b) => b.h));
      const orLow = Math.min(...orBars.map((b) => b.l));
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:45' || parts[i].time >= CUTOFF) continue;
        if (!avgVol[i] || bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const bull = bars[i].c > orHigh, bear = bars[i].c < orLow;
        if (!bull && !bear) continue;
        raw.push({ symbol, day, time: parts[i].time, isBull: bull, price: bars[i].c, bars, parts, dayIndex });
        break;
      }
    }
  }

  if (!fs.existsSync(CACHE_FILE)) { console.log('no option cache, aborting'); return; }
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

  // For each signal, hold to the flatten and measure BOTH legs of the comparison over the
  // identical window: the underlying's signed move, and the option premium's move.
  const rows = [];
  for (const s of raw) {
    const key = `${s.symbol}|${s.day}|${s.isBull ? 'C' : 'P'}`;
    const c = cache[key];
    if (!c) continue;
    const optionBars = c.bars.map(([t, o, h, l, cl]) => ({ t, o, h, l, c: cl }));
    const optParts = optionBars.map(etParts);
    let oi = -1;
    for (let j = 0; j < optionBars.length; j++) if (optParts[j].day === s.day && optParts[j].time >= s.time) { oi = j; break; }
    if (oi < 0) continue;
    const entryPrem = optionBars[oi].o;
    if (!(entryPrem > 0)) continue;
    let lastPrem = entryPrem, lastTime = optParts[oi].time;
    for (let j = oi; j < optionBars.length; j++) {
      if (optParts[j].day !== s.day || optParts[j].time >= FLATTEN) break;
      lastPrem = optionBars[j].c;
      lastTime = optParts[j].time;
    }
    // Underlying over the same window.
    const di = s.dayIndex.get(s.day);
    let uEntry = null, uExit = null;
    for (let i = di.firstIdx; i <= di.lastIdx; i++) {
      const t = s.parts[i].time;
      if (t === s.time) uEntry = s.bars[i].c;
      if (t <= lastTime) uExit = s.bars[i].c;
    }
    if (!uEntry || !uExit) continue;
    const uRet = (s.isBull ? 1 : -1) * (uExit - uEntry) / uEntry; // signed with the trade
    const oRet = (lastPrem - entryPrem) / entryPrem;
    rows.push({ uRet, oRet, entryPrem, spot: uEntry, symbol: s.symbol, day: s.day });
  }

  console.log(`${rows.length} paired trades (option + underlying over the identical hold)\n`);
  if (rows.length < 50) { console.log('too few, aborting'); return; }

  // Empirical leverage: only meaningful where the underlying actually moved, otherwise the
  // ratio is dominated by theta divided by ~zero.
  const moved = rows.filter((r) => Math.abs(r.uRet) > 0.002);
  const levs = moved.map((r) => r.oRet / r.uRet).filter((x) => Number.isFinite(x));

  // Regression through the origin is the robust version: total option move explained per
  // unit of underlying move, immune to the divide-by-small-number blowups above.
  let sxy = 0, sxx = 0;
  for (const r of rows) { sxy += r.uRet * r.oRet; sxx += r.uRet * r.uRet; }
  const beta = sxy / sxx;

  const premPct = rows.map((r) => r.entryPrem / r.spot);

  // NOTE ON METHOD (2026-08-31): an ordinary least-squares decomposition
  //     option_return = alpha + beta x underlying_return
  // was tried here and REMOVED as invalid. It returned alpha = +23.4% (t=6.2), i.e. "holding
  // a near-dated ATM option to the flatten while the underlying goes nowhere GAINS 23%",
  // which directly contradicts the model-free measurement 20 lines below: on the 55 trades
  // where the underlying moved less than 0.1%, the mean option return is -26.3%.
  //
  // Both cannot be true, and the regression is the one that is wrong. A long option's payoff
  // is CONVEX - bounded at -100%, unbounded above (this sample contains real +1000% days, see
  // BACKTEST-BASELINE.md). Fitting a straight line through a convex cloud with a fat right
  // tail drags the intercept up and reports a phantom positive carry. Mean-based statistics
  // are the wrong tool on this distribution; that is the same lesson the option-level
  // expectancy figures in this repo keep re-teaching. Quantiles and conditional means are
  // reported instead.
  const n = rows.length;
  const oRets = rows.map((r) => r.oRet).sort((a, b) => a - b);
  const q = (p) => oRets[Math.min(oRets.length - 1, Math.floor(p * oRets.length))];
  const meanO = rows.reduce((a, r) => a + r.oRet, 0) / n;
  const meanU = rows.reduce((a, r) => a + r.uRet, 0) / n;

  console.log('=== HOLD-TO-FLATTEN OPTION RETURN DISTRIBUTION (no stops, no ratchet) ===');
  console.log(`  n=${n}   mean underlying move ${(10000 * meanU).toFixed(1)}bp`);
  console.log(`  option return:  mean ${(100 * meanO).toFixed(1)}%   MEDIAN ${(100 * q(0.5)).toFixed(1)}%`);
  console.log(`    p10 ${(100 * q(0.10)).toFixed(0)}%   p25 ${(100 * q(0.25)).toFixed(0)}%   p75 ${(100 * q(0.75)).toFixed(0)}%   p90 ${(100 * q(0.90)).toFixed(0)}%   max ${(100 * q(0.999)).toFixed(0)}%`);
  console.log(`  losing trades: ${(100 * oRets.filter((r) => r <= 0).length / n).toFixed(1)}%`);
  const top1 = oRets.slice(-Math.ceil(n * 0.01)).reduce((a, b) => a + b, 0);
  console.log(`  the top 1% of trades (${Math.ceil(n * 0.01)} of ${n}) contribute ${(100 * top1 / n).toFixed(1)} points of the ${(100 * meanO).toFixed(1)}% mean`);
  console.log(`  -> mean WITHOUT the top 1%: ${(100 * (meanO - top1 / n)).toFixed(1)}%`);
  console.log('');

  console.log('=== LEVERAGE (option % move per 1% underlying move) ===');
  console.log(`  regression through origin (all ${rows.length}):     ${beta.toFixed(1)}x`);
  console.log(`  median ratio (|underlying move| > 0.2%, n=${moved.length}): ${median(levs).toFixed(1)}x`);
  console.log(`  ATM premium as % of spot: median ${(100 * median(premPct)).toFixed(2)}%`);

  // Theta: what the option does when the underlying goes essentially nowhere. This is the
  // cost of being long premium, and it is invisible in any underlying-only backtest.
  const flat = rows.filter((r) => Math.abs(r.uRet) < 0.001);
  const flatMean = flat.reduce((a, b) => a + b.oRet, 0) / (flat.length || 1);
  console.log(`\n=== THETA DRAG ===`);
  console.log(`  trades where the underlying moved < 0.1%: n=${flat.length}, mean option return ${(100 * flatMean).toFixed(1)}%`);
  console.log('  (this is what the position loses for being right about nothing - an underlying-only');
  console.log('   backtest scores these as ~0.0bp; the option holder pays for them)');

  console.log('\n=== THE COMPARISON ===');
  const EDGE_BP = 8.1; // BACKTEST-BASELINE.md, n=603, the only well-powered figure here
  const gross = (EDGE_BP / 10000) * beta;
  console.log(`  measured underlying edge:        +${EDGE_BP} bp/trade  (n=603, 90d)`);
  console.log(`  x empirical leverage ${beta.toFixed(1)}x:        = +${(100 * gross).toFixed(2)}% of premium/trade GROSS`);
  console.log('');
  console.log('  round-trip friction, as the live bot is configured:');
  console.log('    entry: limit at mid + 25% of the half-spread');
  console.log('    exit:  MARKET order -> pays the full half-spread');
  console.log(`    MAX_SPREAD_PCT = ${cfg.MAX_SPREAD_PCT} -> half-spread up to ${cfg.MAX_SPREAD_PCT / 2}% of mid`);
  for (const spreadPct of [2, 4, 6, 8]) {
    const half = spreadPct / 2;
    const cost = 0.25 * half + half; // entry quarter-of-half + exit full half
    const verdict = 100 * gross > cost ? 'survives' : 'DOES NOT SURVIVE';
    console.log(`    at a ${spreadPct}% spread: round trip ${cost.toFixed(2)}% of premium -> +${(100 * gross).toFixed(2)}% ${verdict}`);
  }
  console.log(`\n  ...and theta (${(100 * flatMean).toFixed(1)}% on a no-move day) is charged on top of all of it.`);

  console.log('\n=== WHAT SPREAD WOULD BREAK EVEN? ===');
  // cost(spread) = 0.25*(s/2) + (s/2) = 0.625*s  ->  s = gross / 0.625
  const breakeven = (100 * gross) / 0.625;
  console.log(`  ignoring theta entirely, the edge only covers friction below a ${breakeven.toFixed(2)}% bid-ask spread.`);
  console.log(`  MAX_SPREAD_PCT is currently ${cfg.MAX_SPREAD_PCT}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
