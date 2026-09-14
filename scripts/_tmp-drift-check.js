const fs = require('fs');
const lines = fs.readFileSync('logs/trade-log.jsonl', 'utf8').split('\n').filter(Boolean);
const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter(e => e.ts >= '2026-08-03T00:00:00Z');

const entries = new Map(); // symbol -> entry event (last one, in case of reentry same day different date it's fine since symbol includes date)
for (const e of events) {
  if (e.event === 'ENTRY') entries.set(e.symbol, e);
}

const trades = [];
for (const e of events) {
  if (e.event !== 'EXIT') continue;
  const entry = entries.get(e.symbol);
  if (!entry) { console.error('NO ENTRY MATCH for exit', e.symbol, e.ts); continue; }
  const costBasis = entry.premium * 100 * entry.qty;
  const ret = e.pnl / costBasis;
  trades.push({ symbol: e.symbol, underlying: e.underlying, kind: e.kind, pnl: e.pnl, costBasis, ret, reason: e.reason, ts: e.ts });
}

const n = trades.length;
const mean = trades.reduce((s, t) => s + t.ret, 0) / n;
const variance = trades.reduce((s, t) => s + (t.ret - mean) ** 2, 0) / (n - 1);
const sd = Math.sqrt(variance);
const se = sd / Math.sqrt(n);
const tZero = mean / se;
const baseline = 0.20186;
const tBaseline = (mean - baseline) / se;

const singles = trades.filter(t => t.kind === 'single');
const spreads = trades.filter(t => t.kind === 'spread');
function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((s, t) => s + t.ret, 0) / n;
  return { n, mean };
}

console.log(JSON.stringify({
  n, mean, sd, se, tZero, tBaseline,
  singles: stats(singles),
  spreads: stats(spreads),
}, null, 2));
