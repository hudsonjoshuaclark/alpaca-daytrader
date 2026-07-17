// Second-pass sweep: tests alternative signal families against the same first-hit
// bracket engine, since sweep.js showed the live EMA-crossover signal has negative
// expectancy on the underlying in every configuration.
//   A) INVERT  — fade the EMA crossover (mean reversion)
//   B) ORB     — 15-min opening range breakout, RVOL-confirmed, stop at range midpoint,
//                exit end-of-day (no profit target: let trend days run)
//   C) TREND   — EMA crossover only in the direction of the overnight gap AND prior-day trend
// Usage: node --env-file=.env scripts/sweep2.js [days]
const client = require('../lib/alpacaClient');
const { ema, sessionVWAP, rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];

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

// ---- shared bracket sim (same semantics as sweep.js) ----
function simBracket(bars, parts, i, day, entry, isBull, tp, sl, exitTime) {
  const tpLevel = isBull ? entry * (1 + tp) : entry * (1 - tp);
  const slLevel = isBull ? entry * (1 - sl) : entry * (1 + sl);
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= exitTime) break;
    const hitTP = isBull ? bars[j].h >= tpLevel : bars[j].l <= tpLevel;
    const hitSL = isBull ? bars[j].l <= slLevel : bars[j].h >= slLevel;
    if (hitSL) return -sl;
    if (hitTP) return tp;
    lastClose = bars[j].c;
  }
  const move = (lastClose - entry) / entry;
  return isBull ? move : -move;
}

// Stop-only sim: fixed stop level, no target, exit at exitTime close. Returns % move (signed favorable).
function simStopEod(bars, parts, i, day, entry, isBull, stopLevel, exitTime) {
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= exitTime) break;
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

function report(name, results) {
  const n = results.length;
  if (!n) { console.log(`${name}: no trades`); return; }
  const pnl = results.reduce((a, b) => a + b, 0);
  const wins = results.filter((r) => r > 0).length;
  const avgWin = results.filter((r) => r > 0).reduce((a, b) => a + b, 0) / (wins || 1);
  const avgLoss = results.filter((r) => r <= 0).reduce((a, b) => a + b, 0) / ((n - wins) || 1);
  console.log(
    `${name}: n=${n} winRate=${((wins / n) * 100).toFixed(1)}% exp=${((pnl / n) * 10000).toFixed(2)}bp ` +
    `avgWin=${(avgWin * 100).toFixed(3)}% avgLoss=${(avgLoss * 100).toFixed(3)}% tot=${(pnl * 100).toFixed(2)}%`
  );
}

async function main() {
  const days = parseInt(process.argv[2] || '90', 10);
  console.log(`Fetching ${days} days of 5-min bars for ${SYMBOLS.length} symbols...`);
  const data = [];
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const parts = bars.map(etParts);
    // index bars by day for ORB / prior-day context
    const dayIndex = new Map(); // day -> {firstIdx, lastIdx}
    for (let i = 0; i < bars.length; i++) {
      const d = parts[i].day;
      if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i });
      else dayIndex.get(d).lastIdx = i;
    }
    data.push({ symbol, bars, parts, dayIndex, days: [...dayIndex.keys()] });
    console.log(`${symbol}: ${bars.length} bars, ${dayIndex.size} sessions`);
  }

  // ---------- A) INVERTED crossover (fade) ----------
  console.log('\n=== A) Inverted EMA crossover (fade the cross) ===');
  for (const [tp, sl] of [[0.0021, 0.0030], [0.003, 0.003], [0.0030, 0.0021], [0.002, 0.002]]) {
    for (const rvolMin of [1.0, 1.5, 2.0]) {
      const results = [];
      for (const { bars, parts } of data) {
        const closes = bars.map((b) => b.c);
        const fast = ema(closes, cfg.EMA_FAST);
        const slow = ema(closes, cfg.EMA_SLOW);
        const vwap = sessionVWAP(bars);
        const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
        for (let i = cfg.EMA_SLOW + cfg.VOLUME_LOOKBACK + 2; i < bars.length - 1; i++) {
          if ([fast[i - 1], slow[i - 1], fast[i], slow[i], vwap[i], avgVol[i]].some((v) => v == null)) continue;
          const rvol = avgVol[i] > 0 ? bars[i].v / avgVol[i] : 0;
          if (rvol < rvolMin) continue;
          const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
          const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
          const price = closes[i];
          // original signal conditions, but we take the OPPOSITE side
          let isBull = null;
          if (crossedUp && price > vwap[i]) isBull = false;
          else if (crossedDown && price < vwap[i]) isBull = true;
          if (isBull === null) continue;
          results.push(simBracket(bars, parts, i, parts[i].day, price, isBull, tp, sl, '15:45'));
        }
      }
      report(`fade tp=${(tp * 100).toFixed(2)}% sl=${(sl * 100).toFixed(2)}% rvol>=${rvolMin}`, results);
    }
  }

  // ---------- B) ORB 15-min breakout ----------
  console.log('\n=== B) ORB: 15-min opening range breakout, stop at range midpoint, exit EoD ===');
  for (const orMinutes of [15, 30]) {
    for (const rvolMin of [1.0, 1.5]) {
      const results = [];
      for (const { bars, parts, dayIndex } of data) {
        const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
        for (const [day, { firstIdx, lastIdx }] of dayIndex) {
          const orBarCount = orMinutes / 5;
          if (lastIdx - firstIdx < orBarCount + 2) continue;
          // opening range = first orBarCount bars at/after 09:30
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
          // first close beyond the range with volume confirmation, before 14:00
          for (let i = orEnd + 1; i <= lastIdx; i++) {
            if (parts[i].time >= '14:00') break;
            if (avgVol[i] == null || avgVol[i] <= 0) continue;
            const rvol = bars[i].v / avgVol[i];
            if (rvol < rvolMin) continue;
            const c = bars[i].c;
            if (c > orHigh) {
              results.push(simStopEod(bars, parts, i, day, c, true, orMid, '15:45'));
              break;
            }
            if (c < orLow) {
              results.push(simStopEod(bars, parts, i, day, c, false, orMid, '15:45'));
              break;
            }
          }
        }
      }
      report(`ORB ${orMinutes}min rvol>=${rvolMin}`, results);
    }
  }

  // ---------- C) Trend/gap-aligned crossover ----------
  console.log('\n=== C) EMA crossover, only in direction of overnight gap + prior-day trend ===');
  for (const rvolMin of [1.0, 1.5]) {
    const results = [];
    for (const { bars, parts, dayIndex, days: dayList } of data) {
      const closes = bars.map((b) => b.c);
      const fast = ema(closes, cfg.EMA_FAST);
      const slow = ema(closes, cfg.EMA_SLOW);
      const vwap = sessionVWAP(bars);
      const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
      for (let d = 1; d < dayList.length; d++) {
        const prev = dayIndex.get(dayList[d - 1]);
        const cur = dayIndex.get(dayList[d]);
        const prevClose = bars[prev.lastIdx].c;
        const prevOpen = bars[prev.firstIdx].o;
        const todayOpen = bars[cur.firstIdx].o;
        const gapUp = todayOpen > prevClose;
        const prevTrendUp = prevClose > prevOpen;
        // only trade when gap and prior trend agree
        if (gapUp !== prevTrendUp) continue;
        const allowedBull = gapUp;
        for (let i = cur.firstIdx; i <= cur.lastIdx; i++) {
          if ([fast[i - 1], slow[i - 1], fast[i], slow[i], vwap[i], avgVol[i]].some((v) => v == null)) continue;
          if (parts[i].time >= '15:15') break;
          const rvol = avgVol[i] > 0 ? bars[i].v / avgVol[i] : 0;
          if (rvol < rvolMin) continue;
          const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
          const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
          const price = closes[i];
          if (allowedBull && crossedUp && price > vwap[i]) {
            results.push(simBracket(bars, parts, i, parts[i].day, price, true, 0.003, 0.0021, '15:45'));
            break; // one trade per symbol-day
          }
          if (!allowedBull && crossedDown && price < vwap[i]) {
            results.push(simBracket(bars, parts, i, parts[i].day, price, false, 0.003, 0.0021, '15:45'));
            break;
          }
        }
      }
    }
    report(`trend-aligned crossover rvol>=${rvolMin}`, results);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
