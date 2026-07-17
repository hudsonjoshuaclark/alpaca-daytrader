// Robustness checks on the ORB signal before adopting it: per-symbol breakdown,
// per-month stability, entry-cutoff sensitivity, and long-option-friendly exit variants.
// Usage: node --env-file=.env scripts/sweep3.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SOFI', 'MARA', 'RIOT', 'RIVN', 'GME', 'F', 'NIO', 'INTC', 'WBD', 'LCID', 'MU', 'PLTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;

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

// returns { r, exitReason } â€” r = signed favorable % move on underlying
function simStopEod(bars, parts, i, day, entry, isBull, stopLevel, exitTime) {
  let lastClose = entry;
  for (let j = i + 1; j < bars.length; j++) {
    if (parts[j].day !== day) break;
    if (parts[j].time >= exitTime) break;
    const hitStop = isBull ? bars[j].l <= stopLevel : bars[j].h >= stopLevel;
    if (hitStop) {
      const loss = (stopLevel - entry) / entry;
      return { r: isBull ? loss : -loss, exit: 'stop' };
    }
    lastClose = bars[j].c;
  }
  const move = (lastClose - entry) / entry;
  return { r: isBull ? move : -move, exit: 'eod' };
}

function collectTrades(data, { cutoff = '14:00', stopKind = 'mid' } = {}) {
  const trades = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
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
        const rvol = bars[i].v / avgVol[i];
        if (rvol < RVOL_MIN) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true;
        else if (c < orLow) isBull = false;
        if (isBull === null) continue;
        const stopLevel =
          stopKind === 'mid' ? orMid
          : stopKind === 'range' ? (isBull ? orLow : orHigh)
          : null; // 'none'
        const { r, exit } = stopLevel != null
          ? simStopEod(bars, parts, i, day, c, isBull, stopLevel, '15:45')
          : simStopEod(bars, parts, i, day, c, isBull, isBull ? -Infinity : Infinity, '15:45');
        trades.push({ symbol, day, month: day.slice(0, 7), time: parts[i].time, isBull, r, exit });
        break; // one trade per symbol-day
      }
    }
  }
  return trades;
}

function summarize(label, trades) {
  const n = trades.length;
  if (!n) { console.log(`${label}: none`); return; }
  const tot = trades.reduce((a, t) => a + t.r, 0);
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  console.log(
    `${label}: n=${n} winRate=${((wins.length / n) * 100).toFixed(1)}% exp=${((tot / n) * 10000).toFixed(2)}bp ` +
    `avgWin=${((wins.reduce((a, t) => a + t.r, 0) / (wins.length || 1)) * 100).toFixed(3)}% ` +
    `avgLoss=${((losses.reduce((a, t) => a + t.r, 0) / (losses.length || 1)) * 100).toFixed(3)}% tot=${(tot * 100).toFixed(2)}%`
  );
}

async function main() {
  const days = parseInt(process.argv[2] || '90', 10);
  console.log(`Fetching ${days} days of 5-min bars...`);
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

  const base = collectTrades(data);
  console.log('\n=== Per-symbol (ORB15, rvol>=1.5, stop=orMid, exit EoD) ===');
  for (const s of SYMBOLS) summarize(s.padEnd(5), base.filter((t) => t.symbol === s));

  console.log('\n=== Per-month stability ===');
  const months = [...new Set(base.map((t) => t.month))].sort();
  for (const m of months) summarize(m, base.filter((t) => t.month === m));

  console.log('\n=== By direction ===');
  summarize('long ', base.filter((t) => t.isBull));
  summarize('short', base.filter((t) => !t.isBull));

  console.log('\n=== Entry cutoff sensitivity ===');
  for (const cutoff of ['11:00', '12:00', '14:00', '15:15']) {
    summarize(`cutoff ${cutoff}`, collectTrades(data, { cutoff }));
  }

  console.log('\n=== Stop variants (long-option holder can afford wider/no stop) ===');
  for (const stopKind of ['mid', 'range', 'none']) {
    summarize(`stop=${stopKind}`, collectTrades(data, { stopKind }));
  }

  console.log('\n=== Entry time distribution (base config) ===');
  const buckets = {};
  for (const t of base) {
    const b = t.time.slice(0, 2) + ':00';
    buckets[b] = (buckets[b] || 0) + 1;
  }
  console.log(buckets);
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
