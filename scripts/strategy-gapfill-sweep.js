// Candidate strategy #4: gap fill. Research (2026-07-28 survey) was lukewarm on this one
// going in - "one backtest improved to 0.06%/trade but was still far from profitable,"
// gaps <4% usually fill but that's exactly the range most of this universe gaps within -
// included anyway since it's cheap to test with the existing 5-min-bar infra, but going in
// with low expectations rather than assuming it'll clear the bar.
// Mechanism: fade the overnight gap (today's open vs yesterday's close) at the open,
// targeting a return to yesterday's close; stop if the gap extends further; EOD flatten.
//
// Usage: node --env-file=.env scripts/strategy-gapfill-sweep.js [days]
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

function collectTrades(data, { minGap, maxGap }) {
  const trades = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const days = [...dayIndex.keys()].sort();
    for (let d = 1; d < days.length; d++) {
      const prevClose = bars[dayIndex.get(days[d - 1]).lastIdx].c;
      const { firstIdx, lastIdx } = dayIndex.get(days[d]);
      const todayOpen = bars[firstIdx].o;
      const gap = (todayOpen - prevClose) / prevClose;
      if (Math.abs(gap) < minGap || Math.abs(gap) > maxGap) continue;

      const isFadeShort = gap > 0; // gapped up -> fade short toward prev close; gapped down -> fade long
      const entry = todayOpen;
      const target = prevClose;
      const stopLevel = isFadeShort ? entry * (1 + Math.abs(gap) * 0.75) : entry * (1 - Math.abs(gap) * 0.75);

      let r = null;
      let lastClose = entry;
      for (let i = firstIdx + 1; i <= lastIdx; i++) {
        if (parts[i].time >= '15:45') break;
        const hitStop = isFadeShort ? bars[i].h >= stopLevel : bars[i].l <= stopLevel;
        if (hitStop) { r = isFadeShort ? (entry - stopLevel) / entry : (stopLevel - entry) / entry; break; }
        const hitTarget = isFadeShort ? bars[i].l <= target : bars[i].h >= target;
        if (hitTarget) { r = isFadeShort ? (entry - target) / entry : (target - entry) / entry; break; }
        lastClose = bars[i].c;
      }
      if (r == null) r = isFadeShort ? (entry - lastClose) / entry : (lastClose - entry) / entry;
      trades.push({ symbol, day: days[d], r, gap });
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

  console.log('\n=== Gap-fade grid (research suggests small-medium gaps fill more often) ===');
  for (const [minGap, maxGap, label] of [
    [0.005, 0.02, '0.5-2%'],
    [0.01, 0.03, '1-3%'],
    [0.02, 0.04, '2-4%'],
    [0.04, 0.15, '>4% (research: less likely to fill, should do WORSE if the theory holds)'],
  ]) {
    const trades = collectTrades(data, { minGap, maxGap });
    summarize(label, trades.map((t) => t.r));
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
