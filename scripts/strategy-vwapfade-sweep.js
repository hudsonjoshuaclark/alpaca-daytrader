// Candidate strategy #1: VWAP mean-reversion fade. Genuinely different mechanism from
// ORB-15 (which trades momentum continuation on a breakout) - this fades extension away
// from the session VWAP back toward it. Research (2026-07-28 survey): backtests report
// ~55-65% win rate with regime filters, works best mid-session, fails on trend days
// without a filter. Tests a grid of deviation thresholds, RVOL trend-day filters, and
// time-of-day windows against real 5-min bars on the live 12-symbol universe.
//
// Usage: node --env-file=.env scripts/strategy-vwapfade-sweep.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

// Override with SWEEP_SYMBOLS='["SPY","QQQ"]' to test a calmer, less trend-prone subset -
// this universe was chosen for ORB's momentum strategy, which may be a poor fit for a
// reversion strategy like this one.
const SYMBOLS = process.env.SWEEP_SYMBOLS
  ? JSON.parse(process.env.SWEEP_SYMBOLS)
  : ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];

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

function dayVwapSeries(bars, firstIdx, lastIdx) {
  const vwap = new Array(bars.length).fill(null);
  let pv = 0, v = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const typical = (bars[i].h + bars[i].l + bars[i].c) / 3;
    pv += typical * bars[i].v;
    v += bars[i].v;
    vwap[i] = v > 0 ? pv / v : null;
  }
  return vwap;
}

function summarize(label, rs) {
  const n = rs.length;
  if (!n) { console.log(`${label}: none`); return; }
  const tot = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  console.log(
    `${label}: n=${n} winRate=${((wins.length / n) * 100).toFixed(1)}% exp=${((tot / n) * 10000).toFixed(2)}bp ` +
    `avgWin=${((wins.reduce((a, b) => a + b, 0) / (wins.length || 1)) * 100).toFixed(3)}% ` +
    `avgLoss=${((rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / ((n - wins.length) || 1)) * 100).toFixed(3)}% tot=${(tot * 100).toFixed(2)}%`
  );
}

// One trade per symbol-day: first bar (within the time window) that deviates from VWAP
// by >= threshold, faded back toward VWAP. Stop = a further deviation (1.6x threshold).
// Target = VWAP itself. Exit at 15:45 EOD otherwise.
function collectTrades(data, { threshold, minTime, maxTime, rvolMax }) {
  const trades = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      if (lastIdx - firstIdx < 10) continue;
      const vwap = dayVwapSeries(bars, firstIdx, lastIdx);
      let entered = false;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < minTime || parts[i].time >= maxTime) continue;
        if (vwap[i] == null) continue;
        if (rvolMax != null) {
          const rv = avgVol[i] > 0 ? bars[i].v / avgVol[i] : 0;
          if (rv > rvolMax) continue; // trend-day filter: skip abnormally high-volume bars
        }
        const dev = (bars[i].c - vwap[i]) / vwap[i];
        if (Math.abs(dev) < threshold) continue;

        const isFadeShort = dev > 0; // above VWAP -> fade short; below -> fade long
        const entry = bars[i].c;
        const stopLevel = isFadeShort ? entry * (1 + threshold * 0.6) : entry * (1 - threshold * 0.6);
        const target = vwap[i];

        let r = null;
        let lastClose = entry;
        for (let j = i + 1; j <= lastIdx; j++) {
          if (parts[j].time >= '15:45') break;
          const hitStop = isFadeShort ? bars[j].h >= stopLevel : bars[j].l <= stopLevel;
          if (hitStop) { r = isFadeShort ? (entry - stopLevel) / entry : (stopLevel - entry) / entry; break; }
          const hitTarget = isFadeShort ? bars[j].l <= target : bars[j].h >= target;
          if (hitTarget) { r = isFadeShort ? (entry - target) / entry : (target - entry) / entry; break; }
          lastClose = bars[j].c;
        }
        if (r == null) r = isFadeShort ? (entry - lastClose) / entry : (lastClose - entry) / entry;

        trades.push({ symbol, day, r });
        entered = true;
        break; // one trade per symbol-day
      }
      if (entered) continue;
    }
  }
  return trades;
}

async function main() {
  const days = parseInt(process.argv[2] || '90', 10);
  console.log(`Fetching ${days} days of 5-min bars for ${SYMBOLS.length} symbols...`);
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

  console.log('\n=== Grid: deviation threshold x time window (no RVOL filter) ===');
  for (const threshold of [0.005, 0.008, 0.012, 0.018]) {
    for (const [minTime, maxTime, label] of [['09:30', '15:45', 'all-day'], ['10:30', '14:30', 'midday-only']]) {
      const trades = collectTrades(data, { threshold, minTime, maxTime, rvolMax: null });
      summarize(`thresh=${threshold} ${label}`, trades.map((t) => t.r));
    }
  }

  console.log('\n=== Best window with RVOL trend-day filter (skip rvol > 2.5) ===');
  for (const threshold of [0.008, 0.012]) {
    const trades = collectTrades(data, { threshold, minTime: '10:30', maxTime: '14:30', rvolMax: 2.5 });
    summarize(`thresh=${threshold} midday rvolMax=2.5`, trades.map((t) => t.r));
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
