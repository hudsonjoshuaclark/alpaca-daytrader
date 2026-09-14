// Monte Carlo robustness check on a list of historical trade returns: reshuffles trade
// order and resamples with replacement thousands of times, reporting the DISTRIBUTION of
// max drawdown and total return rather than trusting the single historical sequence.
// Directly follows up on the sweep5-options.js finding that the strategy's options-level
// edge is fat-tailed/leverage-amplified and driven by a small number of extreme days
// ("an 8-day window was strongly negative, the 45-day window strongly positive, purely
// from which rare days got included") — this turns that qualitative finding into actual
// drawdown percentiles.
//
// Usage:
//   node scripts/montecarlo.js logs/sweep5-trades.json [iterations]
//   node scripts/montecarlo.js logs/sweep5-trades.json --unit=pct    (returns are % moves)
const fs = require('fs');

function reshuffleRun(returns, rng) {
  // Fisher-Yates shuffle of TRADE ORDER (same trades, different sequence) — tests whether
  // the historical ordering happened to be favorable, not whether the edge is real.
  const arr = returns.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function resampleRun(returns, rng) {
  // Bootstrap resample WITH replacement, same length — tests sensitivity to which
  // specific trades occurred, not just their order.
  const out = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) {
    out[i] = returns[Math.floor(rng() * returns.length)];
  }
  return out;
}

// Simple deterministic PRNG (mulberry32) so runs are reproducible given a seed.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxDrawdown(sequence) {
  let equity = 1, peak = 1, maxDd = 0;
  for (const r of sequence) {
    equity *= (1 + r);
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, (equity - peak) / peak);
  }
  return { maxDd, finalEquity: equity };
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function runMonteCarlo(returns, iterations = 2000, seed = 42) {
  const rng = mulberry32(seed);
  const reshuffleDds = [];
  const reshuffleFinals = [];
  const resampleDds = [];
  const resampleFinals = [];

  for (let i = 0; i < iterations; i++) {
    const rs = maxDrawdown(reshuffleRun(returns, rng));
    reshuffleDds.push(rs.maxDd);
    reshuffleFinals.push(rs.finalEquity);
    const bs = maxDrawdown(resampleRun(returns, rng));
    resampleDds.push(bs.maxDd);
    resampleFinals.push(bs.finalEquity);
  }
  reshuffleDds.sort((a, b) => a - b);
  reshuffleFinals.sort((a, b) => a - b);
  resampleDds.sort((a, b) => a - b);
  resampleFinals.sort((a, b) => a - b);

  const historical = maxDrawdown(returns);

  return {
    n: returns.length,
    historical,
    reshuffle: {
      maxDd: { p5: percentile(reshuffleDds, 0.05), p25: percentile(reshuffleDds, 0.25), median: percentile(reshuffleDds, 0.5), p95: percentile(reshuffleDds, 0.95) },
      finalEquity: { p5: percentile(reshuffleFinals, 0.05), p25: percentile(reshuffleFinals, 0.25), median: percentile(reshuffleFinals, 0.5), p95: percentile(reshuffleFinals, 0.95) },
    },
    resample: {
      maxDd: { p5: percentile(resampleDds, 0.05), p25: percentile(resampleDds, 0.25), median: percentile(resampleDds, 0.5), p95: percentile(resampleDds, 0.95) },
      finalEquity: { p5: percentile(resampleFinals, 0.05), p25: percentile(resampleFinals, 0.25), median: percentile(resampleFinals, 0.5), p95: percentile(resampleFinals, 0.95) },
      // fraction of resampled 45-90 trade sequences that lost money overall — the direct
      // "how often is the fat-tailed edge actually there" number.
      pctProfitable: resampleFinals.filter((e) => e > 1).length / resampleFinals.length,
    },
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/montecarlo.js <trades.json> [iterations] [riskPct]');
    process.exit(1);
  }
  const iterations = parseInt(process.argv[3] || '2000', 10);
  // Trade-return lists from this project's sweep scripts are OPTION PREMIUM % returns
  // (e.g. -0.55 to +11.96), not equity-fraction returns — the live bot risks
  // RISK_PCT_PER_TRADE (30%) of equity per trade, not 100%. Compounding raw premium
  // returns at 100% stake overstates both gains and ruin risk enormously; scale by the
  // real position size to get a meaningful equity curve. Override with a third CLI arg
  // if reasoning about a different sizing assumption.
  const cfg = require('../lib/config');
  const riskPct = process.argv[4] != null ? parseFloat(process.argv[4]) : cfg.RISK_PCT_PER_TRADE;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rawReturns = Array.isArray(raw) ? (typeof raw[0] === 'object' ? raw.map((t) => t.r) : raw) : raw.returns;
  if (!rawReturns || !rawReturns.length) {
    console.error('No returns found in', file);
    process.exit(1);
  }
  console.log(`Scaling raw trade returns by riskPct=${riskPct} (RISK_PCT_PER_TRADE) to approximate equity impact per trade.`);
  console.log('NOTE: this ignores MAX_CONCURRENT_POSITIONS=2 (up to 2 trades can overlap in reality; this models them as sequential) - drawdown here is a rough approximation, not exact.\n');
  const returns = rawReturns.map((r) => r * riskPct);

  const result = runMonteCarlo(returns, iterations);
  console.log(`Monte Carlo on ${result.n} trades, ${iterations} iterations each (reshuffle + bootstrap resample)\n`);
  console.log(`Historical (actual sequence): maxDD=${(result.historical.maxDd * 100).toFixed(1)}% finalEquity=${result.historical.finalEquity.toFixed(2)}x\n`);

  console.log('=== Reshuffle (same trades, random order) ===');
  console.log(`  max drawdown  p5=${(result.reshuffle.maxDd.p5 * 100).toFixed(1)}% p25=${(result.reshuffle.maxDd.p25 * 100).toFixed(1)}% median=${(result.reshuffle.maxDd.median * 100).toFixed(1)}% p95=${(result.reshuffle.maxDd.p95 * 100).toFixed(1)}%`);
  console.log(`  final equity  p5=${result.reshuffle.finalEquity.p5.toFixed(2)}x p25=${result.reshuffle.finalEquity.p25.toFixed(2)}x median=${result.reshuffle.finalEquity.median.toFixed(2)}x p95=${result.reshuffle.finalEquity.p95.toFixed(2)}x`);

  console.log('\n=== Bootstrap resample (with replacement, same sample size) ===');
  console.log(`  max drawdown  p5=${(result.resample.maxDd.p5 * 100).toFixed(1)}% p25=${(result.resample.maxDd.p25 * 100).toFixed(1)}% median=${(result.resample.maxDd.median * 100).toFixed(1)}% p95=${(result.resample.maxDd.p95 * 100).toFixed(1)}%`);
  console.log(`  final equity  p5=${result.resample.finalEquity.p5.toFixed(2)}x p25=${result.resample.finalEquity.p25.toFixed(2)}x median=${result.resample.finalEquity.median.toFixed(2)}x p95=${result.resample.finalEquity.p95.toFixed(2)}x`);
  console.log(`  fraction of resampled runs that ended profitable: ${(result.resample.pctProfitable * 100).toFixed(1)}%`);
}

module.exports = { runMonteCarlo, maxDrawdown };
if (require.main === module) main();
