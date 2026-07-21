// Options-aware validation: replays the exact ORB-15 signals sweep3.js finds (same
// 12-symbol live universe, same orMid stop, same EOD flatten) but against REAL
// historical option premium bars instead of the underlying's own price. This is the
// piece BACKTEST-BASELINE.md explicitly flagged as unvalidated ("options add leverage,
// spread cost, and theta on top" / "divergence is EXPECTED") but never measured.
// Tests whether OPTION_STOP_PCT (55%, never backtested — grep confirms it appears in
// no sweep script) is actually compatible with the underlying-only edge, or is quietly
// cutting every trade short before the validated orMid/EOD exit ever gets a chance.
//
// Usage: node --env-file=.env scripts/sweep5-options.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = '11:30'; // matches live cfg.ORB_ENTRY_CUTOFF
const ZERO_DTE_SYMBOLS = new Set(['SPY', 'QQQ']);

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

async function getOptionBars(occSymbol, dayStart, dayEnd) {
  try {
    const res = await client.data('/v1beta1/options/bars', {
      params: { symbols: occSymbol, timeframe: '5Min', start: dayStart, end: dayEnd, limit: 500 },
    });
    return (res.bars && res.bars[occSymbol]) || [];
  } catch (e) {
    return [];
  }
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}

function nextFridayOnOrAfter(dayStr) {
  const d = new Date(`${dayStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat, Friday=5
  const add = (5 - dow + 7) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

function occDate(dayStr) {
  return dayStr.slice(2).replace(/-/g, ''); // YYYY-MM-DD -> YYMMDD
}

function buildOccSymbol(root, expDate, type, strike) {
  const strikeInt = Math.round(strike * 1000);
  return `${root}${occDate(expDate)}${type === 'call' ? 'C' : 'P'}${String(strikeInt).padStart(8, '0')}`;
}

// Self-calibrating ATM contract finder: tries the plausible strike increments for
// this price tier, queries real historical bars for each candidate, and keeps
// whichever actually has data and sits closest to the exact underlying price —
// same "closest strike wins" logic as lib/contracts.js findNearestContract, just
// operating on constructed OCC symbols against real historical data instead of the
// live contracts-reference endpoint (which only lists currently-active contracts).
async function findHistoricalContract(symbol, day, direction, underlyingPrice) {
  const type = direction === 'bullish' ? 'call' : 'put';
  const expDate = ZERO_DTE_SYMBOLS.has(symbol) ? day : nextFridayOnOrAfter(day);
  const dayStart = `${day}T00:00:00Z`;
  const dayEnd = `${day}T23:59:59Z`;

  const increments = underlyingPrice < 50 ? [1, 2.5, 0.5]
    : underlyingPrice < 300 ? [2.5, 5, 1]
    : [5, 2.5, 10];

  const candidates = new Set();
  for (const inc of increments) {
    const base = Math.round(underlyingPrice / inc) * inc;
    for (const off of [0, -1, 1, -2, 2]) {
      candidates.add(+(base + off * inc).toFixed(2));
    }
  }

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

// Simulates the actual live exit logic (runner.js manageOpenTrades) against real
// option bars: option_stop checked every bar (as live does), then or_mid_stop using
// the underlying, then EOD flatten. optionStopPct=null means no premium stop (the
// 'none' variant sweep3.js already flagged as worth testing for long-option holders).
// entryTime is the ET "HH:MM" of the stock signal's breakout bar — the option position
// is only opened AT that point, not at market open, so both the entry premium and the
// monitoring window must start there, not from the option's first bar of the day.
function simulateExit(optionBars, optBarParts, underlyingBars, underlyingParts, entryTime, day, orMid, isBull, optionStopPct) {
  // find the first option bar at/after the actual signal time — that bar's open is
  // the real entry premium (closest available proxy to the live entry-limit fill)
  let entryIdx = -1;
  for (let j = 0; j < optionBars.length; j++) {
    if (optBarParts[j].day === day && optBarParts[j].time >= entryTime) { entryIdx = j; break; }
  }
  if (entryIdx < 0) return null;
  const entryPremium = optionBars[entryIdx].o;
  if (!entryPremium || entryPremium <= 0) return null;

  // index underlying bars by time for lookup alongside option bar timestamps
  const uByTime = new Map();
  for (let i = 0; i < underlyingBars.length; i++) {
    if (underlyingParts[i].day === day) uByTime.set(underlyingParts[i].time, underlyingBars[i]);
  }

  let lastPremium = entryPremium;
  for (let j = entryIdx; j < optionBars.length; j++) {
    const p = optBarParts[j];
    if (p.day !== day) continue;
    if (p.time >= '15:45') break;
    const bar = optionBars[j];
    lastPremium = bar.c;

    // skip the stop checks on the entry bar itself — we only just opened the position
    if (j === entryIdx) continue;

    if (optionStopPct != null) {
      // We are always LONG the option (calls on bullish signals, puts on bearish) —
      // a loss always means premium went DOWN, regardless of signal direction. The
      // underlying's bullish/bearish direction only matters for the or_mid_stop check
      // below, not here.
      const worst = bar.l;
      const plPct = (worst - entryPremium) / entryPremium;
      if (plPct <= -optionStopPct) {
        return { r: -optionStopPct, exit: 'option_stop' };
      }
    }

    const uBar = uByTime.get(p.time);
    if (uBar) {
      const crossed = isBull ? uBar.l <= orMid : uBar.h >= orMid;
      if (crossed) {
        return { r: (lastPremium - entryPremium) / entryPremium, exit: 'or_mid_stop' };
      }
    }
  }
  return { r: (lastPremium - entryPremium) / entryPremium, exit: 'eod' };
}

async function main() {
  const days = parseInt(process.argv[2] || '45', 10);
  console.log(`Fetching ${days} days of underlying 5-min bars for ${SYMBOLS.length} symbols...`);
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

  // ---- find real ORB signals (identical semantics to sweep3.js) ----
  const signals = [];
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
        if (parts[i].time >= CUTOFF) break;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        const rvol = bars[i].v / avgVol[i];
        if (rvol < RVOL_MIN) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true;
        else if (c < orLow) isBull = false;
        if (isBull === null) continue;
        signals.push({ symbol, day, isBull, orMid, price: c, entryTime: parts[i].time, bars, parts });
        break;
      }
    }
  }
  console.log(`Found ${signals.length} real ORB signals across ${days} days. Resolving option contracts (this makes ~5-10 API calls per signal)...\n`);

  // ---- resolve real historical option contract + bars per signal ----
  const resolved = [];
  let unresolved = 0;
  for (const sig of signals) {
    const contract = await findHistoricalContract(sig.symbol, sig.day, sig.isBull ? 'bullish' : 'bearish', sig.price);
    if (!contract) { unresolved++; continue; }
    const optParts = contract.bars.map(etParts);
    resolved.push({ ...sig, optionBars: contract.bars, optParts, occSymbol: contract.occ, strike: contract.strike });
  }
  console.log(`Resolved ${resolved.length}/${signals.length} signals to real option contracts (${unresolved} unresolved).\n`);

  // ---- simulate live exit logic + alternatives, all on the SAME real option data ----
  for (const stopPct of [0.55, 0.70, 0.85, null]) {
    const results = [];
    const exitCounts = { option_stop: 0, or_mid_stop: 0, eod: 0 };
    const tagged = [];
    for (const r of resolved) {
      const sim = simulateExit(r.optionBars, r.optParts, r.bars, r.parts, r.entryTime, r.day, r.orMid, r.isBull, stopPct);
      if (!sim) continue;
      results.push(sim.r);
      exitCounts[sim.exit]++;
      tagged.push({ symbol: r.symbol, day: r.day, occ: r.occSymbol, entryTime: r.entryTime, r: sim.r, exit: sim.exit });
    }
    const label = stopPct == null ? 'OPTION_STOP_PCT=none' : `OPTION_STOP_PCT=${stopPct}`;
    summarize(label, results);
    console.log(`  exit reasons: option_stop=${exitCounts.option_stop} or_mid_stop=${exitCounts.or_mid_stop} eod=${exitCounts.eod}`);
    if (stopPct === 0.55) {
      const top5 = [...tagged].sort((a, b) => b.r - a.r).slice(0, 5);
      console.log('  TOP 5 WINNERS (for data-quality check):');
      for (const t of top5) console.log(`    ${t.symbol} ${t.day} ${t.occ} entry=${t.entryTime} r=${(t.r * 100).toFixed(1)}% exit=${t.exit}`);
    }
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
