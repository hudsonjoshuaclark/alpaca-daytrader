// Tests four entry-quality filter hypotheses from the 2026-07-28 improvement research
// against the SAME real ORB-15 signals sweep3.js finds (identical OR/RVOL/cutoff logic,
// matching cfg.ORB_ENTRY_CUTOFF=11:30 exactly, not sweep3's default 14:00 sensitivity
// setting) — underlying-level, not options-level, so this is a cheap first gate before
// spending sweep5-options.js's expensive real-option-contract resolution on anything here.
// Per AGENT-REVIEW.md's own bar, none of these get applied to runner.js without evidence.
//
// Filters tested independently (not stacked, so each one's effect is isolated):
//   vwap   - require the breakout bar to close on the signal's side of day-VWAP-so-far
//   relstr - for non-index names, require relative strength vs SPY (long: outperforming,
//            short: underperforming) at the breakout bar; SPY/QQQ exempt (they ARE the
//            benchmark)
//   macro  - exclude CPI/NFP/FOMC-decision days entirely (lib/macroCalendar.js) — the
//            strategy's edge is fat-tailed/rare-day-driven per sweep5-options.js, so this
//            one is explicitly checking whether it's cutting off the tail that IS the edge
//   vol    - bucket days by trailing-10-day SPY realized-range regime (tercile), report
//            expectancy per bucket rather than assuming a gate helps
//
// Usage: node --env-file=.env scripts/sweep6-filters.js [days]
const client = require('../lib/alpacaClient');
const { rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');
const macro = require('../lib/macroCalendar');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];
const OR_MINUTES = 15;
const RVOL_MIN = 1.5;
const CUTOFF = cfg.ORB_ENTRY_CUTOFF; // 11:30 - match live, not sweep3's sensitivity default
const INDEX_SYMBOL = 'SPY';

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

// Cumulative intraday VWAP (typical price * volume, reset at the open) up through each bar.
function dayVwapSeries(bars, parts, firstIdx, lastIdx) {
  const vwap = new Array(bars.length).fill(null);
  let pv = 0, v = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const typical = (bars[i].h + bars[i].l + bars[i].c) / 3;
    pv += typical * bars[i].v;
    v += bars[i].v;
    vwap[i] = v > 0 ? pv / v : null;
  }
  return vwap;
}

async function main() {
  const days = parseInt(process.argv[2] || '90', 10);
  console.log(`Fetching ${days} days of 5-min bars for ${SYMBOLS.length} symbols (cutoff=${CUTOFF})...`);
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
    data[symbol] = { bars, parts, dayIndex };
  }

  // SPY %-change-from-open by day+time, for relative-strength comparisons, and SPY's own
  // daily true-range% by day, for the volatility regime bucketing.
  const spy = data[INDEX_SYMBOL];
  const spyOpenByDay = new Map();
  const spyPctByDayTime = new Map(); // "day|time" -> %change from day's open
  const spyRangePctByDay = new Map();
  for (const [day, { firstIdx, lastIdx }] of spy.dayIndex) {
    const open = spy.bars[firstIdx].o;
    spyOpenByDay.set(day, open);
    let h = -Infinity, l = Infinity;
    for (let i = firstIdx; i <= lastIdx; i++) {
      spyPctByDayTime.set(`${day}|${spy.parts[i].time}`, (spy.bars[i].c - open) / open);
      h = Math.max(h, spy.bars[i].h);
      l = Math.min(l, spy.bars[i].l);
    }
    spyRangePctByDay.set(day, (h - l) / spy.bars[lastIdx].c);
  }
  const allDaysSorted = [...spyRangePctByDay.keys()].sort();
  // trailing-10-day SPY range% regime, computed only from PRIOR days (no lookahead)
  const volRegimeByDay = new Map();
  for (let i = 0; i < allDaysSorted.length; i++) {
    if (i < 10) continue;
    const window = allDaysSorted.slice(i - 10, i).map((d) => spyRangePctByDay.get(d));
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    volRegimeByDay.set(allDaysSorted[i], avg);
  }
  const regimeValues = [...volRegimeByDay.values()].sort((a, b) => a - b);
  const tercileEdges = [regimeValues[Math.floor(regimeValues.length / 3)], regimeValues[Math.floor((2 * regimeValues.length) / 3)]];
  function regimeBucket(day) {
    const v = volRegimeByDay.get(day);
    if (v == null) return null;
    return v <= tercileEdges[0] ? 'low' : v <= tercileEdges[1] ? 'mid' : 'high';
  }

  // ---- collect every real ORB signal once, tagged with everything needed to filter later ----
  const signals = [];
  for (const symbol of SYMBOLS) {
    const { bars, parts, dayIndex } = data[symbol];
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
      const vwapSeries = dayVwapSeries(bars, parts, firstIdx, lastIdx);
      const symbolOpen = bars[firstIdx].o;
      for (let i = orEnd + 1; i <= lastIdx; i++) {
        if (parts[i].time >= CUTOFF) break;
        if (avgVol[i] == null || avgVol[i] <= 0) continue;
        if (bars[i].v / avgVol[i] < RVOL_MIN) continue;
        const c = bars[i].c;
        let isBull = null;
        if (c > orHigh) isBull = true;
        else if (c < orLow) isBull = false;
        if (isBull === null) continue;

        const r = simStopEod(bars, parts, i, day, c, isBull, orMid);
        const vwapAligned = vwapSeries[i] != null ? (isBull ? c > vwapSeries[i] : c < vwapSeries[i]) : null;
        const symPct = (c - symbolOpen) / symbolOpen;
        const spyPct = spyPctByDayTime.get(`${day}|${parts[i].time}`);
        const relStrengthOk = symbol === 'SPY' || symbol === 'QQQ' || spyPct == null
          ? null
          : (isBull ? symPct > spyPct : symPct < spyPct);
        const isMacroDay = macro.isMacroDay(day);
        const regime = regimeBucket(day);

        signals.push({ symbol, day, r, vwapAligned, relStrengthOk, isMacroDay, regime });
        break; // one trade per symbol-day, matches live (tradedUnderlyings)
      }
    }
  }

  console.log(`\nTotal real ORB signals (cutoff ${CUTOFF}): ${signals.length}\n`);

  console.log('=== Baseline (no filter, matches live cfg) ===');
  summarize('baseline', signals.map((s) => s.r));

  console.log('\n=== Filter: VWAP alignment on breakout bar ===');
  const vwapEligible = signals.filter((s) => s.vwapAligned != null);
  summarize('with filter (aligned only)', vwapEligible.filter((s) => s.vwapAligned).map((s) => s.r));
  summarize('excluded by filter (misaligned)', vwapEligible.filter((s) => !s.vwapAligned).map((s) => s.r));

  console.log('\n=== Filter: relative strength vs SPY (SPY/QQQ exempt) ===');
  const rsEligible = signals.filter((s) => s.relStrengthOk != null);
  summarize('with filter (in-favor only)', rsEligible.filter((s) => s.relStrengthOk).map((s) => s.r));
  summarize('excluded by filter (against)', rsEligible.filter((s) => !s.relStrengthOk).map((s) => s.r));
  console.log(`(SPY/QQQ signals exempt from this filter, always included: n=${signals.filter((s) => s.relStrengthOk == null).length})`);

  console.log('\n=== Filter: exclude CPI/NFP/FOMC days ===');
  summarize('with filter (macro days excluded)', signals.filter((s) => !s.isMacroDay).map((s) => s.r));
  summarize('macro days ONLY (what gets cut)', signals.filter((s) => s.isMacroDay).map((s) => s.r));

  console.log('\n=== Volatility regime buckets (trailing 10d SPY range%, tercile) ===');
  for (const bucket of ['low', 'mid', 'high']) {
    summarize(`regime=${bucket}`, signals.filter((s) => s.regime === bucket).map((s) => s.r));
  }
  summarize('regime=unclassified (first 10 days of window)', signals.filter((s) => s.regime == null).map((s) => s.r));

  console.log('\n=== Monthly stability: baseline vs relative-strength-filtered ===');
  const rsFilteredOrExempt = signals.filter((s) => s.relStrengthOk !== false); // keep exempt (null) + in-favor (true)
  const months = [...new Set(signals.map((s) => s.day.slice(0, 7)))].sort();
  for (const m of months) {
    summarize(`  ${m} baseline`, signals.filter((s) => s.day.slice(0, 7) === m).map((s) => s.r));
    summarize(`  ${m} relstr  `, rsFilteredOrExempt.filter((s) => s.day.slice(0, 7) === m).map((s) => s.r));
  }

  console.log('\n=== Top 10 winning trades (fat-tail check: are they on macro days / which vol regime?) ===');
  const top10 = [...signals].sort((a, b) => b.r - a.r).slice(0, 10);
  for (const t of top10) {
    console.log(`  ${t.symbol} ${t.day} r=${(t.r * 100).toFixed(2)}% macroDay=${t.isMacroDay} regime=${t.regime}`);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
