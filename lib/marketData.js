const client = require('./alpacaClient');
const { ema, sessionVWAP, rollingAvgVolume } = require('./indicators');
const cfg = require('./config');

async function getBars(symbols, days = 3) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const res = await client.data('/v2/stocks/bars', {
    params: {
      symbols: symbols.join(','),
      timeframe: cfg.TIMEFRAME,
      start,
      limit: 10000,
      adjustment: 'split',
      feed: 'iex',
    },
  });
  return res.bars || {};
}

// Returns null (no signal) or { direction: 'bullish'|'bearish', price, emaFast, emaSlow, vwap, rvol }
// Rules: EMA9/21 crossover, filtered by VWAP position (trend bias), confirmed by relative volume
// (research-backed combo: EMA gives direction, VWAP gives bias, volume gives conviction)
function computeSignal(barArray) {
  if (!barArray || barArray.length < cfg.EMA_SLOW + cfg.VOLUME_LOOKBACK + 2) return null;
  const closes = barArray.map((b) => b.c);
  const fast = ema(closes, cfg.EMA_FAST);
  const slow = ema(closes, cfg.EMA_SLOW);
  const vwap = sessionVWAP(barArray);
  const avgVol = rollingAvgVolume(barArray, cfg.VOLUME_LOOKBACK);

  const i = closes.length - 1;
  const prevFast = fast[i - 1];
  const prevSlow = slow[i - 1];
  const curFast = fast[i];
  const curSlow = slow[i];
  const curVwap = vwap[i];
  const curAvgVol = avgVol[i];
  const curVol = barArray[i].v;

  if ([prevFast, prevSlow, curFast, curSlow, curVwap, curAvgVol].some((v) => v === null || v === undefined)) {
    return null;
  }

  const rvol = curAvgVol > 0 ? curVol / curAvgVol : 0;
  if (rvol < cfg.RVOL_THRESHOLD) return null; // no volume conviction, skip regardless of direction

  const crossedUp = prevFast <= prevSlow && curFast > curSlow;
  const crossedDown = prevFast >= prevSlow && curFast < curSlow;
  const price = closes[i];

  if (crossedUp && price > curVwap) {
    return { direction: 'bullish', price, emaFast: curFast, emaSlow: curSlow, vwap: curVwap, rvol, barTime: barArray[i].t };
  }
  if (crossedDown && price < curVwap) {
    return { direction: 'bearish', price, emaFast: curFast, emaSlow: curSlow, vwap: curVwap, rvol, barTime: barArray[i].t };
  }
  return null;
}

// --- ORB (opening range breakout) signal — the live strategy ---
// Opening range = first ORB_MINUTES of today's session. Signal fires when the most
// recent COMPLETED bar is the first bar of the day to close outside the range with
// rvol >= ORB_RVOL_MIN, before the entry cutoff. One shot per symbol per day: if the
// first breakout bar wasn't the latest bar (we missed it) this returns null forever
// today — matching the backtest's "enter on the first breakout bar or not at all".
// Returns null or { direction, price, orHigh, orLow, orMid, barTime, rvol }.
function computeORBSignal(barArray, nowET) {
  if (!barArray || barArray.length < cfg.VOLUME_LOOKBACK + 2) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const orBarCount = cfg.ORB_MINUTES / 5;

  const dayOf = (b) => new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const timeOf = (b) =>
    new Date(b.t).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  // collect indexes of today's regular-session bars
  const todayIdx = [];
  for (let i = 0; i < barArray.length; i++) {
    if (dayOf(barArray[i]) === today && timeOf(barArray[i]) >= '09:30') todayIdx.push(i);
  }
  if (todayIdx.length < orBarCount + 1) return null;

  let orHigh = -Infinity;
  let orLow = Infinity;
  for (let k = 0; k < orBarCount; k++) {
    orHigh = Math.max(orHigh, barArray[todayIdx[k]].h);
    orLow = Math.min(orLow, barArray[todayIdx[k]].l);
  }
  const orMid = (orHigh + orLow) / 2;

  const avgVol = rollingAvgVolume(barArray, cfg.VOLUME_LOOKBACK);

  // find the FIRST post-range breakout bar of the day
  for (let k = orBarCount; k < todayIdx.length; k++) {
    const i = todayIdx[k];
    const bar = barArray[i];
    if (timeOf(bar) >= cfg.ORB_ENTRY_CUTOFF) return null;
    const brokeUp = bar.c > orHigh;
    const brokeDown = bar.c < orLow;
    if (!brokeUp && !brokeDown) continue;

    // volume confirmation on the breakout bar itself
    if (avgVol[i] == null || avgVol[i] <= 0) return null;
    const rvol = bar.v / avgVol[i];
    if (rvol < cfg.ORB_RVOL_MIN) {
      // backtest semantics: an unconfirmed breakout bar doesn't consume the day —
      // keep scanning; a later bar can still be the first CONFIRMED breakout
      continue;
    }

    // Only act on a FRESH breakout, not stale history. The last array element may be
    // the still-forming bar (IEX includes it), so accept the breakout bar if it's one
    // of the last two bars AND its close happened within the last few minutes.
    if (i < barArray.length - 2) return null;
    const barCloseMs = new Date(bar.t).getTime() + 5 * 60 * 1000;
    // The bar must have CLOSED. This guard used to test only the upper bound
    // (`Date.now() - barCloseMs > 6 * 60 * 1000`), which rejects a STALE bar but silently
    // admits a still-forming one: for a bar closing in the future that expression is
    // negative, so it passes. The `c` of an unclosed bar is a provisional print that can
    // still reverse before the bar ends, and its `v` is partial - so the bot was entering
    // on breakouts that had not happened yet, against a signal the sweeps never simulated
    // (scripts/sweep3.js iterates finalized bars only).
    //
    // Measured 2026-08-30 from ENTRY_ORDER timestamps: 44 of 69 live entry orders (64%)
    // fired more than 60s into a 5-minute bar block, and the single largest cluster (23)
    // fired in the block's LAST 30 seconds - the point where partial volume has finally
    // accumulated enough to clear ORB_RVOL_MIN while the close can still move. Only 25 of
    // 69 show the "acted on a just-closed bar" signature of firing within 30s of a
    // boundary. So this was the normal path, not a rare edge.
    //
    // Note the live P&L of those trades was NOT worse (-0.67%/trade vs -9.35% for
    // closed-bar entries, t=1.11 on n=50 - noise, and if anything the wrong direction).
    // This is fixed because it makes the deployed strategy the backtested strategy, which
    // is a precondition for any comparison between them meaning anything - not because
    // there is evidence it loses money.
    if (Date.now() < barCloseMs) return null;
    if (Date.now() - barCloseMs > 6 * 60 * 1000) return null;
    return {
      direction: brokeUp ? 'bullish' : 'bearish',
      price: bar.c,
      orHigh,
      orLow,
      orMid,
      barTime: bar.t,
      rvol,
    };
  }
  return null;
}

// Relative-strength-vs-index filter, validated 2026-07-28 (scripts/sweep6-filters.js,
// scripts/sweep7-relstrength-options.js): at the breakout bar, require the symbol to be
// outperforming the index (bullish) or underperforming it (bearish) since today's open.
// 90-day backtest: apples-to-apples baseline 16.38bp -> 18.89bp filtered at the underlying
// level (n=307 kept / 17 removed, removed pool was -28.96bp); options-level cross-check
// showed the same ~16 excluded trades were -1523.74bp there too (n=270 kept, 3044.58bp ->
// 3315.29bp). Returns null if either series lacks a same-time bar (missing data - caller
// should treat that as "can't evaluate," not "blocked").
function computeRelativeStrength(barArray, indexBarArray, signal) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const dayOf = (b) => new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const symbolOpenBar = barArray.find((b) => dayOf(b) === today);
  const indexOpenBar = indexBarArray.find((b) => dayOf(b) === today);
  if (!symbolOpenBar || !indexOpenBar) return null;

  // nearest index bar at-or-before the signal's breakout bar time
  const signalMs = new Date(signal.barTime).getTime();
  let indexBarAtSignal = null;
  for (const b of indexBarArray) {
    if (dayOf(b) !== today) continue;
    const t = new Date(b.t).getTime();
    if (t > signalMs) break;
    indexBarAtSignal = b;
  }
  if (!indexBarAtSignal) return null;

  const symPct = (signal.price - symbolOpenBar.o) / symbolOpenBar.o;
  const indexPct = (indexBarAtSignal.c - indexOpenBar.o) / indexOpenBar.o;
  const aligned = signal.direction === 'bullish' ? symPct > indexPct : symPct < indexPct;
  return { aligned, symPct, indexPct };
}

async function getLatestOptionQuote(optionSymbol) {
  const res = await client.data('/v1beta1/options/quotes/latest', {
    params: { symbols: optionSymbol },
  });
  const q = res.quotes && res.quotes[optionSymbol];
  if (!q) return null;
  return { bid: q.bp, ask: q.ap, mid: (q.bp + q.ap) / 2 };
}

module.exports = { getBars, computeSignal, computeORBSignal, computeRelativeStrength, getLatestOptionQuote };
