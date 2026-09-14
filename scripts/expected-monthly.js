// What does the backtest actually imply for MONTHLY account growth at the deployed config?
//
// Everything in this repo is quoted per-trade, which hides the two things that decide the
// monthly number: how many trades compound in a month, and how much variance drag
// RISK_PCT_PER_TRADE imposes on the way. Arithmetic mean per trade is NOT the growth rate.
// Growth is E[ln(1 + f*r)] — a distribution with a fat left tail compounds far worse than
// its mean suggests, which is the entire reason sizing was cut from 15% to 5%.
//
// Three estimates are produced from the same machinery so they are directly comparable:
//   BACKTEST  the cached real-option trades replayed through the DEPLOYED exit logic
//             (ratchet step/trail/minStopRung 1, OPTION_STOP_PCT, or_mid, flatten)
//   LIVE      the 50 completed live trades, joined EXIT->ENTRY by option symbol
//   LIVE CI   the same, bootstrapped, so the honest uncertainty is visible
//
// Bootstrap resamples whole trades with replacement, TRADES_PER_MONTH at a time, and
// compounds them at f. That propagates the real return distribution — including the fat
// tail that carries all the profit — instead of assuming normality.
//
// Usage: node --env-file=.env scripts/expected-monthly.js [days]
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const ratchet = require('../lib/ratchet');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15, RVOL_MIN = 1.5, CUTOFF = '11:30', FLATTEN = '15:45';
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-orb.json');
const TRADE_LOG = path.join(__dirname, '..', 'logs', 'trade-log.jsonl');

const F = cfg.RISK_PCT_PER_TRADE;      // 0.05 deployed
const COST_GRID = [0.02, 0.04, 0.08];  // round-trip friction as a fraction of exit premium
const BOOT = 20000;

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let all = [], tok = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: { symbols: symbol, timeframe: cfg.TIMEFRAME, start, limit: 10000, adjustment: 'split', feed: 'iex', page_token: tok || undefined },
    });
    all = all.concat(res.bars[symbol] || []);
    tok = res.next_page_token;
  } while (tok);
  return all;
}
function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

// The deployed exit stack, same ordering as runner.js and orb-ratchet-minstoprung.js.
function simulate(sig, cost) {
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
    const advG = (bar.c - entry) / entry;
    if (lowG <= -cfg.OPTION_STOP_PCT) return net(-cfg.OPTION_STOP_PCT);
    const { stop } = ratchet.levelsForRung(rung, cfg.RATCHET_STEP_PCT, cfg.RATCHET_STOP_PCT);
    if (rung >= 1 && lowG <= stop) return net(stop);
    rung = ratchet.rungFor(rung, advG, cfg.RATCHET_STEP_PCT, cfg.RATCHET_MAX_RUNGS || 100);
    const u = uByTime.get(p.time);
    if (u && (isBull ? u.l <= orMid : u.h >= orMid)) return net((last - entry) / entry);
  }
  return net((last - entry) / entry);
}

// Growth of $1 over one month, compounding f of equity per trade.
const monthReturn = (rs, f) => rs.reduce((eq, r) => eq * (1 + f * r), 1) - 1;

function bootstrap(rs, perMonth, f) {
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    let eq = 1;
    for (let i = 0; i < perMonth; i++) eq *= 1 + f * rs[(Math.random() * rs.length) | 0];
    out.push(eq - 1);
  }
  out.sort((a, b) => a - b);
  return out;
}
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const fmtPct = (x) => (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%';

function report(label, rs, perMonth, f) {
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  // Per-trade log growth at f — the quantity that actually compounds.
  const g = rs.reduce((a, r) => a + Math.log(1 + f * r), 0) / n;
  const boot = bootstrap(rs, perMonth, f);
  console.log(`  ${label}`);
  console.log(`    n=${n}  mean/trade ${fmtPct(mean)}  |  at f=${f}: growth ${(100 * (Math.exp(g) - 1)).toFixed(3)}%/trade`);
  console.log(`    EXPECTED MONTHLY (${perMonth} trades, compounded):  ${fmtPct(Math.exp(g * perMonth) - 1)}`);
  console.log(`    bootstrap median ${fmtPct(pct(boot, 0.5))}   80% range ${fmtPct(pct(boot, 0.1))} .. ${fmtPct(pct(boot, 0.9))}`);
  console.log(`    P(month is negative) = ${(100 * boot.filter((x) => x < 0).length / boot.length).toFixed(0)}%`);
  console.log('');
}

async function main() {
  const days = parseInt(process.argv[2] || '240', 10);

  // ---- LIVE ----
  const L = fs.readFileSync(TRADE_LOG, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ent = {};
  for (const e of L) if (e.event === 'ENTRY' && e.symbol) ent[e.symbol] = e;
  const liveR = [];
  const liveDays = new Set();
  for (const e of L) {
    if (e.event !== 'EXIT' || !e.symbol || !ent[e.symbol]) continue;
    const a = ent[e.symbol];
    const cb = (a.premium || 0) * 100 * (a.qty || 1);
    if (cb > 0) { liveR.push(e.pnl / cb); liveDays.add(e.ts.slice(0, 10)); }
  }
  const livePerSession = liveR.length / liveDays.size;
  const LIVE_PER_MONTH = Math.round(livePerSession * 21);

  // ---- BACKTEST ----
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
  const raw = [];
  for (const { symbol, bars, parts, dayIndex } of data) {
    const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
    for (const [day, { firstIdx, lastIdx }] of dayIndex) {
      const orB = [];
      for (let i = firstIdx; i <= lastIdx; i++) if (parts[i].time >= '09:30' && parts[i].time < '09:45') orB.push(bars[i]);
      if (orB.length < OR_MINUTES / 5) continue;
      const orHigh = Math.max(...orB.map((b) => b.h)), orLow = Math.min(...orB.map((b) => b.l));
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (parts[i].time < '09:45' || parts[i].time >= CUTOFF) continue;
        if (!avgVol[i] || bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const bull = bars[i].c > orHigh, bear = bars[i].c < orLow;
        if (!bull && !bear) continue;
        raw.push({ symbol, day, time: parts[i].time, orMid: (orHigh + orLow) / 2, isBull: bull, bars, parts, dayIndex, t: new Date(bars[i].t).getTime() });
        break;
      }
    }
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const signals = [];
  for (const s of raw) {
    const c = cache[`${s.symbol}|${s.day}|${s.isBull ? 'C' : 'P'}`];
    if (!c) continue;
    const optionBars = c.bars.map(([t, o, h, l, cl]) => ({ t, o, h, l, c: cl }));
    const optParts = optionBars.map(etParts);
    let ei = -1;
    for (let j = 0; j < optionBars.length; j++) if (optParts[j].day === s.day && optParts[j].time >= s.time) { ei = j; break; }
    if (ei < 0) continue;
    const uByTime = new Map();
    const di = s.dayIndex.get(s.day);
    for (let i = di.firstIdx; i <= di.lastIdx; i++) uByTime.set(s.parts[i].time, s.bars[i]);
    signals.push({ ...s, optionBars, optParts, entryIdx: ei, uByTime });
  }
  const simDays = new Set(signals.map((s) => s.day));
  const SIM_PER_MONTH = Math.round((signals.length / simDays.size) * 21);

  console.log(`Expected monthly growth at the DEPLOYED config (RISK_PCT_PER_TRADE=${F})\n`);
  console.log(`  backtest: ${signals.length} cached trades over ${simDays.size} sessions -> ${(signals.length / simDays.size).toFixed(1)}/session -> ${SIM_PER_MONTH}/month`);
  console.log(`  live:     ${liveR.length} trades over ${liveDays.size} sessions -> ${livePerSession.toFixed(1)}/session -> ${LIVE_PER_MONTH}/month`);
  console.log(`\n  NOTE: the backtest fires on EVERY signal; live is capped at MAX_CONCURRENT_POSITIONS`);
  console.log(`  and one attempt per symbol per day, and ~22% of entry limits never fill. Live's`);
  console.log(`  ${LIVE_PER_MONTH}/month is the rate that actually compounds.\n`);

  console.log('=== WHAT THE BACKTEST IMPLIES ===\n');
  for (const cost of COST_GRID) {
    const rs = signals.map((s) => simulate(s, cost)).filter((x) => x !== null && Number.isFinite(x));
    report(`round-trip cost ${(100 * cost).toFixed(0)}%  (at live's ${LIVE_PER_MONTH} trades/month)`, rs, LIVE_PER_MONTH, F);
  }

  console.log('=== WHAT LIVE SAYS ===\n');
  report(`50 completed live trades`, liveR, LIVE_PER_MONTH, F);

  console.log('=== REALITY CHECK ===');
  const rs4 = signals.map((s) => simulate(s, 0.04)).filter((x) => x !== null && Number.isFinite(x));
  const g4 = rs4.reduce((a, r) => a + Math.log(1 + F * r), 0) / rs4.length;
  const m4 = Math.exp(g4 * LIVE_PER_MONTH) - 1;
  console.log(`  If the 4%-cost backtest were the truth, $1000 would become:`);
  let eq = 1000;
  for (let m = 1; m <= 6; m++) { eq *= 1 + m4; console.log(`    month ${m}: $${eq.toFixed(0)}`); }
  console.log(`  The account opened at $1000 on 2026-08-03 and is at $2252 - and that gain was a`);
  console.log(`  MANUAL close, not the bot. The backtest's implied path is not what happened.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
