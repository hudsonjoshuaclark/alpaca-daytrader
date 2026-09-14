// Walk-forward validation of the ORB-15 parameter choices (RVOL_MIN, entry cutoff).
// sweep2/sweep3 chose these from ONE historical window and reported the aggregate result
// (BACKTEST-BASELINE.md) — that's a single in-sample fit, not evidence the choice holds up
// on data it wasn't picked from. This splits history into sequential rolling windows: in
// each window, grid-search the small param space to find the "locally best" combo (the
// walk-forward literature's "optimize" step), then check how that combo performs on the
// NEXT window it hasn't seen (the "validate" step) — and specifically whether the live
// config (RVOL_MIN=1.5, cutoff=11:30) stays competitive across windows rather than only
// being right for the one period it was originally chosen from.
//
// Usage: node --env-file=.env scripts/walkforward.js [totalDays] [windowDays]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_GRID = [1.2, 1.5, 1.8, 2.2];
const CUTOFF_GRID = ['11:00', '11:30', '12:00'];
const LIVE_RVOL = cfg.ORB_RVOL_MIN;
const LIVE_CUTOFF = cfg.ORB_ENTRY_CUTOFF;

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

function simStopEod(bars, parts, i, day, entry, isBull, stopLevel) {
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= '15:45') break;
    const hitStop = isBull ? bars[j].l <= stopLevel : bars[j].h >= stopLevel;
    if (hitStop) {
      const loss = (stopLevel - entry) / entry;
      return isBull ? loss : -loss;
    }
    lastClose = bars[j].c;
  }
  const move = (lastClose - entry) / entry;
  return isBull ? move : -move;
}

// Collect ORB trades for one (rvolMin, cutoff) param combo, restricted to a day range.
function collectTrades(data, rvolMin, cutoff, dayStart, dayEnd) {
  const trades = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      if (day < dayStart || day > dayEnd) continue;
      const orBarCount = OR_MINUTES / 5;
      if (lastIdx - firstIdx < orBarCount + 2) continue;
      let orHigh = -Infinity, orLow = Infinity, orEnd = -1, seen = 0;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:30') continue;
        orHigh = Math.max(orHigh, bars[i].h);
        orLow = Math.min(orLow, bars[i].l);
        seen++;
        if (seen === orBarCount) { orEnd = i; break; }
      }
      if (orEnd < 0) continue;
      const orMid = (orHigh + orLow) / 2;
      for (let i = orEnd + 1; i <= lastIdx; i++) {
        if (parts[i].time >= cutoff) break;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        if (bars[i].v / avgVol[i] < rvolMin) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true;
        else if (c < orLow) isBull = false;
        if (isBull === null) continue;
        const r = simStopEod(bars, parts, i, day, c, isBull, orMid);
        trades.push(r);
        break;
      }
    }
  }
  return trades;
}

function expectancyBp(trades) {
  if (!trades.length) return { n: 0, bp: null };
  const tot = trades.reduce((a, b) => a + b, 0);
  return { n: trades.length, bp: (tot / trades.length) * 10000 };
}

async function main() {
  const totalDays = parseInt(process.argv[2] || '180', 10);
  const windowDays = parseInt(process.argv[3] || '30', 10);
  console.log(`Fetching ${totalDays} days of 5-min bars for ${SYMBOLS.length} symbols...`);
  const data = [];
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, totalDays);
    const parts = bars.map(etParts);
    const dayIndex = new Map();
    for (let i = 0; i < bars.length; i++) {
      const d = parts[i].day;
      if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i });
      else dayIndex.get(d).lastIdx = i;
    }
    data.push({ symbol, bars, parts, dayIndex });
  }

  const allDays = [...new Set(data.flatMap((d) => [...d.dayIndex.keys()]))].sort();
  console.log(`Actual trading days available: ${allDays.length} (${allDays[0]} to ${allDays[allDays.length - 1]})`);
  if (allDays.length < windowDays * 2) {
    console.log(`Not enough history for even 2 windows of ${windowDays} calendar days - shortening window.`);
  }

  // Build sequential windows of ~windowDays calendar days each from the available trading days.
  const windows = [];
  let idx = 0;
  while (idx < allDays.length) {
    const startDay = allDays[idx];
    const startTime = new Date(startDay).getTime();
    let endIdx = idx;
    while (endIdx < allDays.length && (new Date(allDays[endIdx]).getTime() - startTime) < windowDays * 86400000) endIdx++;
    windows.push({ start: allDays[idx], end: allDays[endIdx - 1] });
    idx = endIdx;
  }
  console.log(`Split into ${windows.length} windows:`, windows.map((w) => `${w.start}..${w.end}`).join(' | '));

  if (windows.length < 2) {
    console.log('Need at least 2 windows to walk forward - increase totalDays or decrease windowDays.');
    return;
  }

  // In-sample grid search per window + out-of-sample validation on the NEXT window.
  const perWindowBest = [];
  console.log('\n=== Per-window grid search (in-sample "optimize" step) ===');
  for (const w of windows) {
    let best = null;
    const grid = [];
    for (const rvolMin of RVOL_GRID) {
      for (const cutoff of CUTOFF_GRID) {
        const trades = collectTrades(data, rvolMin, cutoff, w.start, w.end);
        const { n, bp } = expectancyBp(trades);
        grid.push({ rvolMin, cutoff, n, bp });
        if (bp != null && n >= 5 && (!best || bp > best.bp)) best = { rvolMin, cutoff, n, bp };
      }
    }
    const live = grid.find((g) => g.rvolMin === LIVE_RVOL && g.cutoff === LIVE_CUTOFF);
    console.log(`Window ${w.start}..${w.end}: best-in-sample=rvol${best?.rvolMin}/${best?.cutoff} (n=${best?.n}, ${best?.bp?.toFixed(1)}bp) | live-config n=${live?.n} ${live?.bp?.toFixed(1)}bp`);
    perWindowBest.push({ window: w, best, live, grid });
  }

  console.log('\n=== Out-of-sample validation: each window\'s in-sample winner tested on the NEXT window ===');
  for (let i = 0; i < perWindowBest.length - 1; i++) {
    const chosen = perWindowBest[i].best;
    const nextWindow = perWindowBest[i + 1].window;
    if (!chosen) { console.log(`Window ${i}: no viable in-sample winner (too few trades)`); continue; }
    const oosTrades = collectTrades(data, chosen.rvolMin, chosen.cutoff, nextWindow.start, nextWindow.end);
    const oos = expectancyBp(oosTrades);
    const liveOosTrades = collectTrades(data, LIVE_RVOL, LIVE_CUTOFF, nextWindow.start, nextWindow.end);
    const liveOos = expectancyBp(liveOosTrades);
    console.log(
      `In-sample winner from window ${i} (rvol${chosen.rvolMin}/${chosen.cutoff}, was ${chosen.bp.toFixed(1)}bp) ` +
      `-> next window OOS: n=${oos.n} ${oos.bp != null ? oos.bp.toFixed(1) : 'n/a'}bp` +
      ` | live config (rvol${LIVE_RVOL}/${LIVE_CUTOFF}) same window: n=${liveOos.n} ${liveOos.bp != null ? liveOos.bp.toFixed(1) : 'n/a'}bp`
    );
  }

  console.log('\n=== Live config expectancy sign, all windows ===');
  const signs = perWindowBest.map((p) => p.live && p.live.bp != null ? Math.sign(p.live.bp) : 0);
  console.log(`Windows: ${perWindowBest.length}, positive: ${signs.filter((s) => s > 0).length}, negative: ${signs.filter((s) => s < 0).length}, no-data: ${signs.filter((s) => s === 0).length}`);
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
