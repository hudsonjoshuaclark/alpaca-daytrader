// Candidate strategy #2: overnight close-to-open momentum drift. Genuinely different
// TIMEFRAME from ORB-15 (swing/overnight hold vs same-day flatten) - one of the most
// robust documented anomalies in the academic literature (2026-07-28 survey): momentum
// strategies' abnormal returns concentrate almost entirely overnight, not intraday.
// Signal: today's own intraday return (open->close) predicts the overnight (close->next
// open) return in the SAME direction (continuation), enter near the close, exit near the
// next day's open. Tests a grid of signal thresholds and both directions (long calls on
// strong up days, long puts on strong down days - this account trades options only, so
// "shorting" just means buying a put, same execution shape as ORB's bearish trades).
//
// Usage: node --env-file=.env scripts/strategy-overnight-sweep.js [days]
const client = require('../lib/alpacaClient');
const cfg = require('../lib/config');

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

function buildDaily(bars, parts) {
  const dayIndex = new Map();
  for (let i = 0; i < bars.length; i++) {
    const d = parts[i].day;
    if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i });
    else dayIndex.get(d).lastIdx = i;
  }
  const days = [...dayIndex.keys()].sort();
  return days.map((day) => {
    const { firstIdx, lastIdx } = dayIndex.get(day);
    return { day, open: bars[firstIdx].o, close: bars[lastIdx].c };
  });
}

function collectTrades(dailyBySymbol, { threshold, lateHalfOnly }) {
  const trades = [];
  for (const [symbol, daily] of Object.entries(dailyBySymbol)) {
    for (let i = 0; i < daily.length - 1; i++) {
      const today = daily[i];
      const tomorrow = daily[i + 1];
      const todayReturn = (today.close - today.open) / today.open;
      if (Math.abs(todayReturn) < threshold) continue;
      const overnightReturn = (tomorrow.open - today.close) / today.close;
      // long calls on a strong up day (continuation), long puts on a strong down day -
      // both expressed as "r = favorable % move," matching this project's convention.
      const r = todayReturn > 0 ? overnightReturn : -overnightReturn;
      trades.push({ symbol, day: today.day, r, direction: todayReturn > 0 ? 'bullish' : 'bearish' });
    }
  }
  return trades;
}

async function main() {
  const days = parseInt(process.argv[2] || '180', 10);
  console.log(`Fetching ${days} days of 5-min bars for ${SYMBOLS.length} symbols (need daily open/close only, but reusing the 5-min endpoint already in use elsewhere)...`);
  const dailyBySymbol = {};
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const parts = bars.map(etParts);
    dailyBySymbol[symbol] = buildDaily(bars, parts);
  }
  const totalDays = Math.max(...Object.values(dailyBySymbol).map((d) => d.length));
  console.log(`Got ~${totalDays} trading days per symbol.\n`);

  console.log('=== Grid: today-return threshold, both directions ===');
  for (const threshold of [0.005, 0.01, 0.015, 0.02, 0.03]) {
    const trades = collectTrades(dailyBySymbol, { threshold });
    summarize(`thresh=${(threshold * 100).toFixed(1)}%`, trades.map((t) => t.r));
  }

  console.log('\n=== By direction (thresh=1.5%) ===');
  const t15 = collectTrades(dailyBySymbol, { threshold: 0.015 });
  summarize('long (bullish continuation)', t15.filter((t) => t.direction === 'bullish').map((t) => t.r));
  summarize('short/put (bearish continuation)', t15.filter((t) => t.direction === 'bearish').map((t) => t.r));

  console.log('\n=== Per-symbol (thresh=1.5%) ===');
  for (const s of SYMBOLS) {
    const rs = t15.filter((t) => t.symbol === s).map((t) => t.r);
    if (rs.length) summarize(s.padEnd(5), rs);
  }

  console.log('\n=== Per-month stability (thresh=1.5%, BOTH directions combined) ===');
  const months = [...new Set(t15.map((t) => t.day.slice(0, 7)))].sort();
  for (const m of months) summarize(m, t15.filter((t) => t.day.slice(0, 7) === m).map((t) => t.r));

  console.log('\n=== LONG-ONLY (bullish continuation), per-symbol, thresh=1.5% ===');
  const longOnly = t15.filter((t) => t.direction === 'bullish');
  for (const s of SYMBOLS) {
    const rs = longOnly.filter((t) => t.symbol === s).map((t) => t.r);
    if (rs.length) summarize(s.padEnd(5), rs);
  }
  console.log('\n=== LONG-ONLY per-month stability, thresh=1.5% ===');
  for (const m of months) summarize(m, longOnly.filter((t) => t.day.slice(0, 7) === m).map((t) => t.r));

  console.log('\n=== LONG-ONLY at other thresholds ===');
  for (const threshold of [0.005, 0.01, 0.02, 0.03]) {
    const trades = collectTrades(dailyBySymbol, { threshold }).filter((t) => t.direction === 'bullish');
    summarize(`thresh=${(threshold * 100).toFixed(1)}%`, trades.map((t) => t.r));
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
