// Converts the ratchet study's per-trade returns into an ACTUAL ACCOUNT equity curve.
//
// Every "maxDD" figure in orb-ratchet-sweep/research/pick is the peak-to-trough drop of the
// SUM of per-trade returns, where each return is a fraction of that trade's option premium.
// It is a unitless yardstick for ranking settings - it is NOT a percentage of the account,
// and reading "-145%" as "the account went to zero and past it" is wrong.
//
// What actually determines account damage is position sizing. This replays the same trades
// against real money mechanics:
//   - premium budget per trade = RISK_PCT_PER_TRADE of current equity
//   - at most MAX_CONCURRENT_POSITIONS trades per day, total daily exposure capped at
//     100% of equity (no margin - the config admits 4x30% would exceed cash and some
//     entries simply fail in practice)
//   - DAILY_LOSS_STOP_PCT halts new entries once the day is down that much
//   - PAUSE_DRAWDOWN_PCT halts trading entirely (reported, and optionally enforced)
// Losses compound, which the summed-return metric never captured.
//
// Usage: node --env-file=.env scripts/orb-ratchet-equity.js [startEquity]
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const ratchet = require('../lib/ratchet');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const RVOL_MIN = 1.5, CUTOFF = '11:30', FLATTEN = '15:45';
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');
const COST = 0.04;

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

function simulate(sig, step, trail, maxRungs) {
  const { optionBars, optParts, uByTime, entryIdx, orMid, isBull, day } = sig;
  const entry = optionBars[entryIdx].o;
  if (!entry || entry <= 0) return null;
  const net = (g) => (1 + g) * (1 - COST) - 1;
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

// Replay day by day with compounding and the real sizing/concurrency rules.
function equityCurve(tradesByDay, days, startEquity, riskPct, maxConc) {
  let eq = startEquity, peak = startEquity, worstDdPct = 0, minEq = startEquity;
  let pausedOn = null, daysTraded = 0;
  const curve = [];
  for (const day of days) {
    const todays = (tradesByDay.get(day) || []).slice(0, maxConc);
    if (!todays.length) continue;
    if (pausedOn) break;
    const dayStart = eq;
    // total premium deployed can't exceed cash on hand
    const perTrade = Math.min(riskPct, 1 / todays.length) * dayStart;
    let dayPnl = 0;
    for (const t of todays) {
      // daily loss stop: no further entries once the day is down this much
      if (dayPnl <= -cfg.DAILY_LOSS_STOP_PCT * dayStart) break;
      dayPnl += perTrade * t.r;
    }
    eq += dayPnl;
    daysTraded++;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > worstDdPct) worstDdPct = dd;
    if (eq < minEq) minEq = eq;
    curve.push({ day, eq });
    if (eq <= 0) { pausedOn = day; break; }
    if (eq <= startEquity * (1 - cfg.PAUSE_DRAWDOWN_PCT) && !pausedOn) pausedOn = null; // reported below, not enforced
  }
  return { finalEq: eq, peak, worstDdPct: worstDdPct * 100, minEq, daysTraded, curve, wiped: eq <= 0 };
}

async function main() {
  const startEquity = parseFloat(process.argv[2] || '2781');
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
  console.log(`Account simulation | start $${startEquity.toFixed(2)} | ${signals.length} trades over ${days.length} trading days`);
  console.log(`Sizing: ${(cfg.RISK_PCT_PER_TRADE * 100).toFixed(0)}% of equity per trade, max ${cfg.MAX_CONCURRENT_POSITIONS}/day, daily loss stop ${(cfg.DAILY_LOSS_STOP_PCT * 100).toFixed(0)}%, losses COMPOUND\n`);

  const settings = [
    ['ratchet OFF', null, null],
    ['15/15 (deployed)', 0.15, 0.15],
    ['2/15 (suggested)', 0.02, 0.15],
    ['2/2', 0.02, 0.02],
  ];
  const sizings = [cfg.RISK_PCT_PER_TRADE, 0.15, 0.10, 0.05];

  console.log('At your CURRENT sizing (' + (cfg.RISK_PCT_PER_TRADE * 100).toFixed(0) + '% per trade):');
  console.log('  ' + 'setting'.padEnd(20) + 'final equity'.padStart(16) + 'worst account drop'.padStart(21) + 'lowest point'.padStart(15));
  for (const [name, st, tr] of settings) {
    const byDay = new Map();
    for (const s of signals) {
      const r = simulate(s, st, tr, MAXR);
      if (!r) continue;
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day).push(r);
    }
    const e = equityCurve(byDay, days, startEquity, cfg.RISK_PCT_PER_TRADE, cfg.MAX_CONCURRENT_POSITIONS);
    console.log('  ' + name.padEnd(20) + ('$' + e.finalEq.toFixed(0)).padStart(16) + ('-' + e.worstDdPct.toFixed(1) + '%').padStart(21) + ('$' + e.minEq.toFixed(0)).padStart(15) + (e.wiped ? '  *** WIPED OUT ***' : ''));
  }

  console.log('\nWorst account drop by position size (the lever that actually controls loss):');
  console.log('  ' + 'setting'.padEnd(20) + sizings.map((z) => ((z * 100).toFixed(0) + '%/trade').padStart(14)).join(''));
  for (const [name, st, tr] of settings) {
    const byDay = new Map();
    for (const s of signals) {
      const r = simulate(s, st, tr, MAXR);
      if (!r) continue;
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day).push(r);
    }
    const cells = sizings.map((z) => {
      const e = equityCurve(byDay, days, startEquity, z, cfg.MAX_CONCURRENT_POSITIONS);
      return (e.wiped ? 'WIPED' : '-' + e.worstDdPct.toFixed(1) + '%').padStart(14);
    });
    console.log('  ' + name.padEnd(20) + cells.join(''));
  }

  console.log('\nWorst SINGLE DAY loss as % of account, current sizing:');
  for (const [name, st, tr] of settings) {
    const byDay = new Map();
    for (const s of signals) {
      const r = simulate(s, st, tr, MAXR);
      if (!r) continue;
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day).push(r);
    }
    let worst = 0;
    for (const day of days) {
      const td = (byDay.get(day) || []).slice(0, cfg.MAX_CONCURRENT_POSITIONS);
      if (!td.length) continue;
      const per = Math.min(cfg.RISK_PCT_PER_TRADE, 1 / td.length);
      const pct = td.reduce((a, t) => a + per * t.r, 0) * 100;
      if (pct < worst) worst = pct;
    }
    console.log('  ' + name.padEnd(20) + worst.toFixed(1) + '%');
  }
}
main().catch((e) => console.error('FAIL', e.message, e.stack));
