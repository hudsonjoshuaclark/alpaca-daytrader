// Backtests the live entry signal (EMA9/21 crossover + VWAP filter + volume confirmation)
// against real historical 5-min bars. Single-pass over precomputed indicator arrays —
// measures forward price behavior after each historical signal to evaluate whether the
// entry condition has real predictive edge.
// NOTE: this is a signal-quality backtest on the UNDERLYING, not an options P&L backtest —
// Alpaca requires a paid OPRA agreement for historical option quotes, which this account
// does not have. Option P&L would additionally depend on IV/theta/spread not modeled here.
const client = require('../lib/alpacaClient');
const { ema, sessionVWAP, rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const LOOKAHEAD_BARS = 12; // 12 x 5min = 60 minutes forward window
const FAVORABLE_MOVE_PCT = 0.001; // 0.10% underlying move = "favorable"

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let allBars = [];
  let pageToken = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: {
        symbols: symbol,
        timeframe: cfg.TIMEFRAME,
        start,
        limit: 10000,
        adjustment: 'split',
        feed: 'iex',
        page_token: pageToken || undefined,
      },
    });
    allBars = allBars.concat(res.bars[symbol] || []);
    pageToken = res.next_page_token;
  } while (pageToken);
  return allBars;
}

function dayKeyOf(bar) {
  return new Date(bar.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function backtestSymbol(bars) {
  const minWarmup = cfg.EMA_SLOW + cfg.VOLUME_LOOKBACK + 2;
  const closes = bars.map((b) => b.c);
  const fast = ema(closes, cfg.EMA_FAST);
  const slow = ema(closes, cfg.EMA_SLOW);
  const vwap = sessionVWAP(bars);
  const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
  const dayKeys = bars.map(dayKeyOf); // single O(n) pass, cached for the whole run

  const signals = [];

  for (let i = minWarmup; i < bars.length - 1; i++) {
    const prevFast = fast[i - 1];
    const prevSlow = slow[i - 1];
    const curFast = fast[i];
    const curSlow = slow[i];
    const curVwap = vwap[i];
    const curAvgVol = avgVol[i];
    if ([prevFast, prevSlow, curFast, curSlow, curVwap, curAvgVol].some((v) => v == null)) continue;

    const rvol = curAvgVol > 0 ? bars[i].v / curAvgVol : 0;
    if (rvol < cfg.RVOL_THRESHOLD) continue;

    const crossedUp = prevFast <= prevSlow && curFast > curSlow;
    const crossedDown = prevFast >= prevSlow && curFast < curSlow;
    if (!crossedUp && !crossedDown) continue;

    const price = closes[i];
    let direction = null;
    if (crossedUp && price > curVwap) direction = 'bullish';
    else if (crossedDown && price < curVwap) direction = 'bearish';
    if (!direction) continue;

    const entryDay = dayKeys[i];
    const lookaheadEnd = Math.min(i + LOOKAHEAD_BARS, bars.length - 1);
    let maxFavorable = 0;
    let maxAdverse = 0;
    for (let j = i + 1; j <= lookaheadEnd; j++) {
      if (dayKeys[j] !== entryDay) break; // 0DTE: stop tracking at session end
      const move = (bars[j].c - price) / price;
      const signedMove = direction === 'bullish' ? move : -move;
      maxFavorable = Math.max(maxFavorable, signedMove);
      maxAdverse = Math.min(maxAdverse, signedMove);
    }

    let outcome;
    if (maxFavorable >= FAVORABLE_MOVE_PCT && maxFavorable > Math.abs(maxAdverse)) outcome = 'favorable';
    else if (maxAdverse <= -FAVORABLE_MOVE_PCT) outcome = 'adverse';
    else outcome = 'flat';

    signals.push({ time: bars[i].t, direction, maxFavorable, maxAdverse, outcome });
  }

  return signals;
}

async function main() {
  const days = parseInt(process.argv[2] || '60', 10);
  for (const symbol of cfg.SYMBOLS) {
    console.log(`\n=== ${symbol} — last ${days} calendar days ===`);
    const bars = await getHistoricalBars(symbol, days);
    const tradingDays = new Set(bars.map(dayKeyOf)).size;
    console.log(`Bars fetched: ${bars.length} across ~${tradingDays} trading days`);

    const signals = backtestSymbol(bars);
    const favorable = signals.filter((s) => s.outcome === 'favorable').length;
    const adverse = signals.filter((s) => s.outcome === 'adverse').length;
    const flat = signals.filter((s) => s.outcome === 'flat').length;
    const avgFav = signals.reduce((s, x) => s + x.maxFavorable, 0) / (signals.length || 1);
    const avgAdv = signals.reduce((s, x) => s + x.maxAdverse, 0) / (signals.length || 1);

    console.log(`Total signals: ${signals.length}  (~${(signals.length / tradingDays).toFixed(2)}/day)`);
    console.log(`Favorable: ${favorable} (${((favorable / signals.length) * 100 || 0).toFixed(1)}%)  Adverse: ${adverse} (${((adverse / signals.length) * 100 || 0).toFixed(1)}%)  Flat: ${flat} (${((flat / signals.length) * 100 || 0).toFixed(1)}%)`);
    console.log(`Avg max favorable move: ${(avgFav * 100).toFixed(3)}%   Avg max adverse move: ${(avgAdv * 100).toFixed(3)}%`);

    const bullish = signals.filter((s) => s.direction === 'bullish');
    const bearish = signals.filter((s) => s.direction === 'bearish');
    const bullFav = bullish.filter((s) => s.outcome === 'favorable').length;
    const bearFav = bearish.filter((s) => s.outcome === 'favorable').length;
    console.log(`Bullish signals: ${bullish.length}, favorable rate ${((bullFav / bullish.length) * 100 || 0).toFixed(1)}%`);
    console.log(`Bearish signals: ${bearish.length}, favorable rate ${((bearFav / bearish.length) * 100 || 0).toFixed(1)}%`);
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
