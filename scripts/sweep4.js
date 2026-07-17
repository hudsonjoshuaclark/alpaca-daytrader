// Final validation: ORB on the $1000-affordable universe, gated by a daily
// screener-like top-N selection (prior-day composite of rvol/range/trend — same
// weights as lib/screener.js). This replicates what the live bot actually does:
// trade ORB only on the names the screener would have picked that morning.
// Usage: node --env-file=.env scripts/sweep4.js [days] [topN]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

// Names whose near-term ATM/first-OTM contract plausibly fits a ~$400 budget.
const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'PLTR', 'AMD', 'RIVN', 'GME', 'F', 'NIO', 'LCID', 'WBD', 'MU', 'SOFI', 'MARA', 'RIOT', 'INTC'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30';

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

async function main() {
  const days = parseInt(process.argv[2] || '90', 10);
  const topN = parseInt(process.argv[3] || '6', 10);
  console.log(`Fetching ${days} days of 5-min bars for ${SYMBOLS.length} symbols...`);
  const data = {};
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const parts = bars.map(etParts);
    const dayIndex = new Map();
    for (let i = 0; i < bars.length; i++) {
      const d = parts[i].day;
      if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i });
      else dayIndex.get(d).lastIdx = i;
    }
    // daily aggregates for screener composite
    const daily = [...dayIndex.entries()].map(([day, { firstIdx, lastIdx }]) => {
      let v = 0, h = -Infinity, l = Infinity;
      for (let i = firstIdx; i <= lastIdx; i++) { v += bars[i].v; h = Math.max(h, bars[i].h); l = Math.min(l, bars[i].l); }
      return { day, v, h, l, c: bars[lastIdx].c };
    });
    data[symbol] = { bars, parts, dayIndex, daily };
  }

  // composite score per symbol per day, computed from data up to and including day d-1
  function compositeAt(symbol, dayIdx) {
    const daily = data[symbol].daily;
    if (dayIdx < 21) return null;
    const win = daily.slice(dayIdx - 20, dayIdx); // prior 20 days
    const last = daily[dayIdx - 1]; // yesterday
    const avgVol = win.slice(0, -1).reduce((a, d) => a + d.v, 0) / (win.length - 1);
    const rvol = avgVol > 0 ? last.v / avgVol : 0;
    const rangePct = ((last.h - last.l) / last.c) * 100;
    const fiveAgo = daily[dayIdx - 6] || daily[0];
    const trendPct = Math.abs((last.c - fiveAgo.c) / fiveAgo.c) * 100;
    return rvol * 0.4 + rangePct * 0.3 + trendPct * 0.3;
  }

  const allDays = [...new Set(Object.values(data).flatMap((d) => [...d.dayIndex.keys()]))].sort();

  const gated = [];
  const ungated = [];
  for (let di = 21; di < allDays.length; di++) {
    const day = allDays[di];
    // rank symbols by yesterday's composite
    const ranked = SYMBOLS
      .map((s) => {
        const idx = data[s].daily.findIndex((d) => d.day === day);
        return { s, score: idx > 0 ? compositeAt(s, idx) : null };
      })
      .filter((x) => x.score != null)
      .sort((a, b) => b.score - a.score);
    const picked = new Set(ranked.slice(0, topN).map((x) => x.s));

    for (const symbol of SYMBOLS) {
      const { bars, parts, dayIndex } = data[symbol];
      const info = dayIndex.get(day);
      if (!info) continue;
      const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
      const orBarCount = OR_MINUTES / 5;
      let orHigh = -Infinity, orLow = Infinity, orEnd = -1, seen = 0;
      for (let i = info.firstIdx; i <= info.lastIdx; i++) {
        if (parts[i].time < '09:30') continue;
        orHigh = Math.max(orHigh, bars[i].h);
        orLow = Math.min(orLow, bars[i].l);
        seen++;
        if (seen === orBarCount) { orEnd = i; break; }
      }
      if (orEnd < 0) continue;
      const orMid = (orHigh + orLow) / 2;
      for (let i = orEnd + 1; i <= info.lastIdx; i++) {
        if (parts[i].time >= CUTOFF) break;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        if (bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true;
        else if (c < orLow) isBull = false;
        if (isBull === null) continue;
        const r = simStopEod(bars, parts, i, day, c, isBull, orMid);
        ungated.push({ symbol, day, r });
        if (picked.has(symbol)) gated.push({ symbol, day, r });
        break;
      }
    }
  }

  console.log(`\n=== Affordable universe, cutoff ${CUTOFF} ===`);
  summarize('ungated (all 16 names)', ungated.map((t) => t.r));
  summarize(`screener-gated (top ${topN}/day)`, gated.map((t) => t.r));

  console.log('\nPer-month (gated):');
  for (const m of [...new Set(gated.map((t) => t.day.slice(0, 7)))].sort()) {
    summarize(m, gated.filter((t) => t.day.slice(0, 7) === m).map((t) => t.r));
  }
  console.log('\nPer-symbol (gated):');
  for (const s of SYMBOLS) {
    const rs = gated.filter((t) => t.symbol === s).map((t) => t.r);
    if (rs.length) summarize(s.padEnd(5), rs);
  }
  console.log(`\nGated trades/day avg: ${(gated.length / (allDays.length - 21)).toFixed(2)}`);
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
