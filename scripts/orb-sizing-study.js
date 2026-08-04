// Position-size study for ORB-15: what does cutting RISK_PCT_PER_TRADE actually cost in
// growth, and what does it buy in drawdown?
//
// Two things make this non-obvious:
//  1. COMPOUNDING. Growth is geometric, not linear. Doubling size does not double growth;
//     past a point volatility drag makes bigger size grow the account SLOWER while still
//     deepening drawdowns. Whether 30% is past that point is an empirical question.
//  2. THE EDGE IS OVERSTATED. This study's own trade returns come from option-bar
//     backtesting with no bid-ask, no partial fills and no market impact - the same
//     methodology that produced an implausible ~20%/trade. The optimal position size scales
//     with the TRUE edge, so an inflated edge produces an inflated "safe" size. The only
//     honest way to use this is to check whether the conclusion survives the edge being far
//     worse than measured, which is what the cost haircut column does.
//
// Usage: node --env-file=.env scripts/orb-sizing-study.js
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const ratchet = require('../lib/ratchet');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const RVOL_MIN = 1.5, CUTOFF = '11:30', FLATTEN = '15:45';
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');
const SIZES = [0.30, 0.25, 0.20, 0.15, 0.10, 0.05, 0.02];
// Round-trip friction. 4% is the realistic-ish base; the larger values are deliberate
// haircuts standing in for "the backtest edge is overstated by this much per trade".
const COSTS = [0.04, 0.10, 0.20, 0.30];
const SETTING = { name: '2/15', step: 0.02, trail: 0.15 };

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
    const lowG = (bar.l - entry) / entry, advG = (bar.c - entry) / entry;
    if (lowG <= -cfg.OPTION_STOP_PCT) return { r: net(-cfg.OPTION_STOP_PCT) };
    if (step != null) {
      const { stop } = ratchet.levelsForRung(rung, step, trail);
      if (rung >= 1 && lowG <= stop) return { r: net(stop) };
      rung = ratchet.rungFor(rung, advG, step, maxRungs);
    }
    const u = uByTime.get(p.time);
    if (u && (isBull ? u.l <= orMid : u.h >= orMid)) return { r: net((last - entry) / entry) };
  }
  return { r: net((last - entry) / entry) };
}

function replay(byDay, days, riskPct) {
  let eq = 1, peak = 1, worstDd = 0, worstDay = 0, ruin = false;
  for (const day of days) {
    const td = (byDay.get(day) || []).slice(0, cfg.MAX_CONCURRENT_POSITIONS);
    if (!td.length) continue;
    const dayStart = eq;
    const per = Math.min(riskPct, 1 / td.length) * dayStart;
    let pnl = 0;
    for (const t of td) {
      if (pnl <= -cfg.DAILY_LOSS_STOP_PCT * dayStart) break;
      pnl += per * t.r;
    }
    const dayPct = pnl / dayStart;
    if (dayPct < worstDay) worstDay = dayPct;
    eq += pnl;
    if (eq <= 0) { ruin = true; eq = 0; break; }
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > worstDd) worstDd = dd;
  }
  return { mult: eq, worstDdPct: worstDd * 100, worstDayPct: worstDay * 100, ruin };
}

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
  const days = [...new Set(signals.map((s) => s.day))].sort();
  const MAXR = cfg.RATCHET_MAX_RUNGS || 100;
  console.log(`Position-size study | ratchet ${SETTING.name} | ${signals.length} trades, ${days.length} trading days (~8 months)\n`);

  for (const cost of COSTS) {
    const byDay = new Map();
    let sum = 0, cnt = 0;
    for (const s of signals) {
      const r = simulate(s, SETTING.step, SETTING.trail, cost, MAXR);
      if (!r) continue;
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day).push(r);
      sum += r.r; cnt++;
    }
    const perTradeEdge = (sum / cnt) * 100;
    console.log(`--- round-trip cost ${(cost * 100).toFixed(0)}%  =>  avg edge ${perTradeEdge.toFixed(2)}% per trade ${cost === 0.04 ? '(base case)' : '(HAIRCUT: what if the backtest is this much too rosy)'}`);
    console.log('    size   growth over 8mo    worst drop   worst day   growth per unit of drop');
    let best = null;
    const rows = SIZES.map((z) => {
      const e = replay(byDay, days, z);
      if (!best || (!e.ruin && e.mult > best.mult)) best = { ...e, z };
      return { z, ...e };
    });
    for (const r of rows) {
      const ratio = r.ruin ? 0 : (r.mult - 1) / (r.worstDdPct || 1);
      const growth = r.ruin ? 'RUIN' : (r.mult >= 1000 ? r.mult.toExponential(1) : r.mult.toFixed(2)) + 'x';
      const mark = best && r.z === best.z ? '  <- fastest growth' : '';
      console.log(`    ${(r.z * 100).toFixed(0).padStart(3)}%   ${growth.padStart(15)}   ${('-' + r.worstDdPct.toFixed(1) + '%').padStart(10)}   ${('-' + Math.abs(r.worstDayPct).toFixed(1) + '%').padStart(9)}   ${ratio.toFixed(2).padStart(12)}${mark}`);
    }
    console.log('');
  }
  console.log('growth per unit of drop = (growth-1) / worst drop %. Higher = more return for the pain taken.');
  console.log('Growth multiples are RELATIVE comparisons only - the underlying per-trade edge is');
  console.log('backtest-inflated, so treat the SHAPE of each column, not the absolute numbers.');
}
main().catch((e) => console.error('FAIL', e.message, e.stack));
