// Runs the ACTUAL production signal/screener code against a broad historical dataset
// (full watchlist, not just SPY/QQQ) to surface crashes, NaN/Infinity output, and edge
// cases. This is a code-correctness stress test, not a strategy backtest — see
// scripts/backtest.js for signal-quality evaluation on SPY/QQQ specifically.
const client = require('../lib/alpacaClient');
const md = require('../lib/marketData');
const { scoreSymbolForTest } = require('../lib/screener');
const watchlist = require('../lib/watchlist');
const cfg = require('../lib/config');

const issues = [];

function flag(context, message) {
  issues.push({ context, message });
  console.log('ISSUE:', context, '-', message);
}

async function getBars(symbols, timeframe, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let allBars = {};
  let pageToken = null;
  let pages = 0;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: { symbols: symbols.join(','), timeframe, start, limit: 10000, adjustment: 'split', feed: 'iex', page_token: pageToken || undefined },
    });
    for (const [sym, bars] of Object.entries(res.bars || {})) {
      allBars[sym] = (allBars[sym] || []).concat(bars);
    }
    pageToken = res.next_page_token;
    pages++;
  } while (pageToken && pages < 60);
  return allBars;
}

function isBadNumber(n) {
  return typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n);
}

async function stressSignalEngine() {
  console.log('\n=== Signal engine: full watchlist, 45 days of 5-min bars ===');
  const bars = await getBars(watchlist, '5Min', 45);
  let totalBars = 0;
  let totalSignals = 0;
  let symbolsWithData = 0;

  for (const symbol of watchlist) {
    const symBars = bars[symbol];
    if (!symBars || symBars.length === 0) {
      flag(symbol, 'no bars returned at all');
      continue;
    }
    symbolsWithData++;
    totalBars += symBars.length;

    const minWarmup = cfg.EMA_SLOW + cfg.VOLUME_LOOKBACK + 2;
    // Sample every 5th bar rather than every single one — computeSignal recomputes
    // indicators over the whole window each call (fine for production's fixed small
    // window, but O(n) per call adds up to O(n^2) walking bar-by-bar through months
    // of history). Sampling keeps this calling the real, unmodified function while
    // staying fast; still exercises thousands of real windows per symbol.
    const SAMPLE_STEP = 5;
    for (let i = minWarmup; i < symBars.length; i += SAMPLE_STEP) {
      const window = symBars.slice(0, i + 1);
      let signal;
      try {
        signal = md.computeSignal(window);
      } catch (e) {
        flag(symbol, `computeSignal threw at bar ${i} (${symBars[i].t}): ${e.message}`);
        continue;
      }
      if (!signal) continue;
      totalSignals++;
      if (isBadNumber(signal.price) || isBadNumber(signal.emaFast) || isBadNumber(signal.emaSlow) || isBadNumber(signal.vwap) || isBadNumber(signal.rvol)) {
        flag(symbol, `bad number in signal at ${symBars[i].t}: ${JSON.stringify(signal)}`);
      }
      if (signal.direction !== 'bullish' && signal.direction !== 'bearish') {
        flag(symbol, `unexpected direction "${signal.direction}" at ${symBars[i].t}`);
      }
    }
  }

  console.log(`Symbols with data: ${symbolsWithData}/${watchlist.length}`);
  console.log(`Total bars processed: ${totalBars}`);
  console.log(`Total signals generated: ${totalSignals}`);
}

async function stressScreenerScoring() {
  console.log('\n=== Screener scoring: full watchlist, 120 days of daily bars ===');
  const bars = await getBars(watchlist, '1Day', 120);

  for (const symbol of watchlist) {
    const symBars = bars[symbol];
    if (!symBars || symBars.length < 21) {
      flag(symbol, `insufficient daily bars for scoring (${symBars ? symBars.length : 0})`);
      continue;
    }
    // Walk forward through history, not just the latest day — re-scores at each
    // point using only bars available up to that point, same as production would see it.
    for (let i = 21; i < symBars.length; i++) {
      const window = symBars.slice(0, i + 1);
      let score;
      try {
        score = scoreSymbolForTest(window);
      } catch (e) {
        flag(symbol, `scoreSymbol threw at day ${i} (${symBars[i].t}): ${e.message}`);
        continue;
      }
      if (!score) continue;
      if (isBadNumber(score.rvol) || isBadNumber(score.atrPct) || isBadNumber(score.trendStrengthPct) || isBadNumber(score.compositeScore)) {
        flag(symbol, `bad number in score at ${symBars[i].t}: ${JSON.stringify(score)}`);
      }
      if (score.compositeScore < 0) {
        flag(symbol, `negative composite score at ${symBars[i].t}: ${score.compositeScore}`);
      }
    }
  }
  console.log('Screener scoring stress test complete.');
}

async function main() {
  await stressSignalEngine();
  await stressScreenerScoring();

  console.log(`\n=== Summary: ${issues.length} issue(s) found ===`);
  for (const issue of issues) {
    console.log('-', issue.context, ':', issue.message);
  }
}

main().catch((e) => console.error('STRESS TEST CRASHED:', e.message, e.stack));
