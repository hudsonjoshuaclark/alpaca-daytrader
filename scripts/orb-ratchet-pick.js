// Follow-up analysis on the cached 240-day option data (logs/option-cache-orb.json).
// Answers the question the grid tops alone can't: the best-scoring cells keep landing on
// the tightest trail tested, but MAX_SPREAD_PCT admits an 8% bid-ask, so any trail near or
// below that is triggering on quote noise rather than price. This re-runs the same honest
// model (ratchet advances on bar CLOSE) and reports the best SPREAD-SAFE setting alongside
// the unconstrained one, both walk-forward tested.
// Usage: node --env-file=.env scripts/orb-ratchet-pick.js
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const ratchet = require('../lib/ratchet');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const RVOL_MIN = 1.5, CUTOFF = '11:30', FLATTEN = '15:45';
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');
const STEP_GRID = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
const TRAIL_GRID = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
const COST = 0.04;
// A trail must clear the worst spread the bot will accept, or it fires on the bid-ask
// rather than on the trade going against us. MAX_SPREAD_PCT is 8, so 15% ~ 2x headroom.
const SPREAD_SAFE_MIN_TRAIL = 0.15;

async function getBars(symbol, days) {
  const start = new Date(Date.now() - days * 864e5).toISOString();
  let all = [], tok = null;
  do {
    const res = await client.data('/v2/stocks/bars', { params: { symbols: symbol, timeframe: cfg.TIMEFRAME, start, limit: 10000, adjustment: 'split', feed: 'iex', page_token: tok || undefined } });
    all = all.concat(res.bars[symbol] || []); tok = res.next_page_token;
  } while (tok);
  return all;
}
const etParts = (b) => {
  const d = new Date(b.t);
  return { day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) };
};

function simulate(sig, step, trail, cost, maxRungs) {
  const { optionBars, optParts, uByTime, entryIdx, orMid, isBull, day } = sig;
  const entry = optionBars[entryIdx].o;
  if (!entry || entry <= 0) return null;
  const net = (g) => (1 + g) * (1 - cost) - 1;
  let last = entry, rung = 0;
  for (let j = entryIdx; j < optionBars.length; j++) {
    const p = optParts[j];
    if (p.day !== day) continue;
    if (p.time >= FLATTEN) break;
    const bar = optionBars[j];
    last = bar.c;
    if (j === entryIdx) continue;
    const lowG = (bar.l - entry) / entry;
    const advG = (bar.c - entry) / entry; // CLOSE only - no intrabar look-ahead
    if (lowG <= -cfg.OPTION_STOP_PCT) return { r: net(-cfg.OPTION_STOP_PCT), exit: 'option_stop', rung };
    if (step != null) {
      const { stop } = ratchet.levelsForRung(rung, step, trail);
      if (rung >= 1 && lowG <= stop) return { r: net(stop), exit: 'trail_stop', rung };
      rung = ratchet.rungFor(rung, advG, step, maxRungs);
    }
    const u = uByTime.get(p.time);
    if (u && (isBull ? u.l <= orMid : u.h >= orMid)) return { r: net((last - entry) / entry), exit: 'or_mid_stop', rung };
  }
  return { r: net((last - entry) / entry), exit: 'eod', rung };
}
function maxDD(rs) { let c = 0, pk = 0, w = 0; for (const r of rs) { c += r; if (c > pk) pk = c; if (pk - c > w) w = pk - c; } return w; }
function stats(res) {
  const n = res.length; if (!n) return null;
  const ch = res.slice().sort((a, b) => a.t - b.t), rs = ch.map((r) => r.r);
  const tot = rs.reduce((a, b) => a + b, 0), losses = rs.filter((r) => r <= 0);
  const bm = new Map();
  for (const r of ch) { const m = r.day.slice(0, 7); if (!bm.has(m)) bm.set(m, []); bm.get(m).push(r.r); }
  const months = [...bm.entries()].sort().map(([m, a]) => ({ month: m, n: a.length, expBp: (a.reduce((x, y) => x + y, 0) / a.length) * 1e4 }));
  return { n, expBp: (tot / n) * 1e4, lossRatePct: losses.length / n * 100, avgLossPct: (losses.reduce((a, b) => a + b, 0) / (losses.length || 1)) * 100, maxDdPct: maxDD(rs) * 100, months, posMonths: months.filter((m) => m.expBp > 0).length, exits: res.reduce((a, r) => { a[r.exit] = (a[r.exit] || 0) + 1; return a; }, {}), avgRung: res.reduce((a, r) => a + (r.rung || 0), 0) / n };
}
const fmt = (l, s) => `${l.padEnd(20)} n=${String(s.n).padStart(4)} avgProfit/trade=${(s.expBp / 100).toFixed(2).padStart(6)}% worstDrop=${(s.maxDdPct).toFixed(0).padStart(5)}% loseRate=${s.lossRatePct.toFixed(1).padStart(5)}% avgLoss=${s.avgLossPct.toFixed(1).padStart(6)}% monthsUp=${s.posMonths}/${s.months.length}`;

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const data = [];
  for (const symbol of SYMBOLS) {
    const bars = await getBars(symbol, 240), parts = bars.map(etParts), di = new Map();
    for (let i = 0; i < bars.length; i++) { const d = parts[i].day; if (!di.has(d)) di.set(d, { firstIdx: i, lastIdx: i }); else di.get(d).lastIdx = i; }
    data.push({ symbol, bars, parts, dayIndex: di });
  }
  const signals = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const av = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const orB = [];
      for (let i = firstIdx; i <= lastIdx; i++) if (parts[i].time >= '09:30' && parts[i].time < '09:45') orB.push(bars[i]);
      if (orB.length < 3) continue;
      const oh = Math.max(...orB.map((b) => b.h)), ol = Math.min(...orB.map((b) => b.l)), orMid = (oh + ol) / 2;
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:45' || parts[i].time >= CUTOFF) continue;
        if (!av[i] || bars[i].v / av[i] < RVOL_MIN) continue;
        const bull = bars[i].c > oh, bear = bars[i].c < ol;
        if (!bull && !bear) continue;
        const c = cache[`${symbol}|${day}|${bull ? 'C' : 'P'}`];
        if (c) {
          const ob = c.bars.map(([t, o, h, l, cl]) => ({ t, o, h, l, c: cl })), op = ob.map(etParts);
          let ei = -1;
          for (let j = 0; j < ob.length; j++) if (op[j].day === day && op[j].time >= parts[i].time) { ei = j; break; }
          if (ei >= 0) {
            const ubt = new Map();
            for (let k = firstIdx; k <= lastIdx; k++) ubt.set(parts[k].time, bars[k]);
            signals.push({ symbol, day, orMid, isBull: bull, t: new Date(bars[i].t).getTime(), optionBars: ob, optParts: op, entryIdx: ei, uByTime: ubt });
          }
        }
        break;
      }
    }
  }
  const MAXR = cfg.RATCHET_MAX_RUNGS || 100;
  const run = (set, st, tr) => stats(set.map((s) => { const r = simulate(s, st, tr, COST, MAXR); return r && { day: s.day, t: s.t, ...r }; }).filter(Boolean));
  const sorted = signals.slice().sort((a, b) => a.t - b.t), mid = Math.floor(sorted.length / 2);
  const IS = sorted.slice(0, mid), OOS = sorted.slice(mid);
  console.log(`n=${signals.length} | honest model (advance on close) | ${COST * 100}% round-trip cost\n`);

  const rows = [];
  for (const st of STEP_GRID) for (const tr of TRAIL_GRID) { const s = run(signals, st, tr); s.step = st; s.trail = tr; rows.push(s); }

  console.log('FULL SAMPLE');
  console.log('  ' + fmt('ratchet OFF', run(signals, null, null)));
  console.log('  ' + fmt('deployed 15/15', rows.find((r) => r.step === 0.15 && r.trail === 0.15)));
  const safe = rows.filter((r) => r.trail >= SPREAD_SAFE_MIN_TRAIL);
  console.log(`\n  best by worst-drop, ALL cells:`);
  for (const r of rows.slice().sort((a, b) => a.maxDdPct - b.maxDdPct).slice(0, 3)) console.log('    ' + fmt(`step=${(r.step * 100).toFixed(0)} trail=${(r.trail * 100).toFixed(0)}`, r));
  console.log(`  best by worst-drop, SPREAD-SAFE only (trail >= ${SPREAD_SAFE_MIN_TRAIL * 100}%):`);
  for (const r of safe.slice().sort((a, b) => a.maxDdPct - b.maxDdPct).slice(0, 5)) console.log('    ' + fmt(`step=${(r.step * 100).toFixed(0)} trail=${(r.trail * 100).toFixed(0)}`, r));

  console.log('\nWALK-FORWARD (pick on Dec-Apr, judge on Apr-Aug)');
  const isRows = [];
  for (const st of STEP_GRID) for (const tr of TRAIL_GRID) { const s = run(IS, st, tr); if (s) { s.step = st; s.trail = tr; isRows.push(s); } }
  const picks = [
    ['unconstrained min-drop', isRows.slice().sort((a, b) => a.maxDdPct - b.maxDdPct)[0]],
    ['spread-safe min-drop', isRows.filter((r) => r.trail >= SPREAD_SAFE_MIN_TRAIL).sort((a, b) => a.maxDdPct - b.maxDdPct)[0]],
    ['deployed 15/15', isRows.find((r) => r.step === 0.15 && r.trail === 0.15)],
  ];
  console.log('  ' + fmt('  OOS ratchet OFF', run(OOS, null, null)));
  for (const [name, p] of picks) {
    if (!p) continue;
    const o = run(OOS, p.step, p.trail);
    console.log(`  ${name} -> step=${(p.step * 100).toFixed(0)} trail=${(p.trail * 100).toFixed(0)}`);
    console.log('    ' + fmt('  in-sample', p));
    console.log('    ' + fmt('  OUT-SAMPLE', o));
  }

  const best = rows.filter((r) => r.trail >= SPREAD_SAFE_MIN_TRAIL).sort((a, b) => a.maxDdPct - b.maxDdPct)[0];
  console.log(`\nMonth-by-month, spread-safe best (step=${(best.step * 100).toFixed(0)} trail=${(best.trail * 100).toFixed(0)}) vs ratchet OFF:`);
  const off = run(signals, null, null);
  for (let i = 0; i < best.months.length; i++) {
    const b = best.months[i], o = off.months[i];
    console.log(`  ${b.month}  n=${String(b.n).padStart(3)}   ratchet ${(b.expBp / 100).toFixed(2).padStart(7)}%   off ${(o.expBp / 100).toFixed(2).padStart(7)}%`);
  }
  console.log(`\n  exits=${JSON.stringify(best.exits)} avgRung=${best.avgRung.toFixed(2)}`);
}
main().catch((e) => console.error('FAIL', e.message, e.stack));
