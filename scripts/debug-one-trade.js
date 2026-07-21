// One-off debug: dumps the full underlying + option bar path for the first few
// resolved historical signals, so the sweep5-options.js simulation can be manually
// verified against raw data before trusting its aggregate output.
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15, RVOL_MIN = 1.5, CUTOFF = '11:30';
const ZERO_DTE_SYMBOLS = new Set(['SPY', 'QQQ']);

function etParts(bar) {
  const d = new Date(bar.t);
  return { day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) };
}
async function getBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let all = [], pt = null;
  do { const res = await client.data('/v2/stocks/bars', { params: { symbols: symbol, timeframe: cfg.TIMEFRAME, start, limit: 10000, adjustment: 'split', feed: 'iex', page_token: pt || undefined } }); all = all.concat(res.bars[symbol] || []); pt = res.next_page_token; } while (pt);
  return all;
}
async function getOptionBars(occSymbol, dayStart, dayEnd) {
  try { const res = await client.data('/v1beta1/options/bars', { params: { symbols: occSymbol, timeframe: '5Min', start: dayStart, end: dayEnd, limit: 500 } }); return (res.bars && res.bars[occSymbol]) || []; }
  catch (e) { return []; }
}
function nextFridayOnOrAfter(dayStr) { const d = new Date(`${dayStr}T12:00:00Z`); const dow = d.getUTCDay(); const add = (5 - dow + 7) % 7; d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); }
function occDate(dayStr) { return dayStr.slice(2).replace(/-/g, ''); }
function buildOccSymbol(root, expDate, type, strike) { const strikeInt = Math.round(strike * 1000); return `${root}${occDate(expDate)}${type === 'call' ? 'C' : 'P'}${String(strikeInt).padStart(8, '0')}`; }

async function findHistoricalContract(symbol, day, direction, underlyingPrice) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const expDate = ZERO_DTE_SYMBOLS.has(symbol) ? day : nextFridayOnOrAfter(day);
  const dayStart = `${day}T00:00:00Z`, dayEnd = `${day}T23:59:59Z`;
  const increments = underlyingPrice < 50 ? [1, 2.5, 0.5] : underlyingPrice < 300 ? [2.5, 5, 1] : [5, 2.5, 10];
  const candidates = new Set();
  for (const inc of increments) { const base = Math.round(underlyingPrice / inc) * inc; for (const off of [0, -1, 1, -2, 2]) candidates.add(+(base + off * inc).toFixed(2)); }
  let best = null;
  for (const strike of candidates) {
    if (strike <= 0) continue;
    const occ = buildOccSymbol(symbol, expDate, type, strike);
    const bars = await getOptionBars(occ, dayStart, dayEnd);
    if (bars.length === 0) continue;
    const diff = Math.abs(strike - underlyingPrice);
    if (!best || diff < best.diff) best = { occ, strike, diff, bars, expDate };
  }
  return best;
}

async function main() {
  const days = parseInt(process.argv[2] || '8', 10);
  const wantN = parseInt(process.argv[3] || '3', 10);
  const data = [];
  for (const symbol of SYMBOLS) {
    const bars = await getBars(symbol, days);
    const parts = bars.map(etParts);
    const dayIndex = new Map();
    for (let i = 0; i < bars.length; i++) { const d = parts[i].day; if (!dayIndex.has(d)) dayIndex.set(d, { firstIdx: i, lastIdx: i }); else dayIndex.get(d).lastIdx = i; }
    data.push({ symbol, bars, parts, dayIndex });
  }

  let shown = 0;
  for (const { symbol, bars, parts, dayIndex } of data) {
    if (shown >= wantN) break;
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      if (shown >= wantN) break;
      const orBarCount = OR_MINUTES / 5;
      if (lastIdx - firstIdx < orBarCount + 2) continue;
      let orHigh = -Infinity, orLow = Infinity, orEnd = -1, seen = 0;
      for (let i = firstIdx; i <= lastIdx; i++) { if (parts[i].time < '09:30') continue; orHigh = Math.max(orHigh, bars[i].h); orLow = Math.min(orLow, bars[i].l); seen++; if (seen === orBarCount) { orEnd = i; break; } }
      if (orEnd < 0) continue;
      const orMid = (orHigh + orLow) / 2;
      for (let i = orEnd + 1; i <= lastIdx; i++) {
        if (parts[i].time >= CUTOFF) break;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        if (bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true; else if (c < orLow) isBull = false;
        if (isBull === null) continue;

        console.log(`\n=== ${symbol} ${day} ${isBull ? 'BULLISH' : 'BEARISH'} entryTime=${parts[i].time} entryPrice(underlying)=${c} orHigh=${orHigh.toFixed(2)} orLow=${orLow.toFixed(2)} orMid=${orMid.toFixed(2)} ===`);
        const contract = await findHistoricalContract(symbol, day, isBull ? 'bullish' : 'bearish', c);
        if (!contract) { console.log('  no contract resolved'); break; }
        console.log(`  contract: ${contract.occ} (strike ${contract.strike}, diff ${contract.diff.toFixed(2)})`);
        const optParts = contract.bars.map(etParts);
        console.log('  option bars around entry+after (time, o/h/l/c):');
        for (let j = 0; j < contract.bars.length; j++) {
          if (optParts[j].time < parts[i].time && optParts[j].time !== contract.bars[0]) continue;
          if (optParts[j].time >= '15:50') break;
          const b = contract.bars[j];
          console.log(`    ${optParts[j].time}  o=${b.o} h=${b.h} l=${b.l} c=${b.c}`);
        }
        shown++;
        break;
      }
    }
  }
}
main().catch((e) => console.error('FAIL', e.message, e.stack));
