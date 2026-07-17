// Parameter sweep over the live entry signal, evaluated with a first-hit bracket
// simulation on the underlying (proxy for the option bracket exits the bot actually
// uses). Sweeps RVOL threshold and time-of-day windows across a liquid subset of the
// watchlist, then sweeps bracket levels on the best filter combo.
// Usage: node --env-file=.env scripts/sweep.js [days]
const client = require('../lib/alpacaClient');
const { ema, sessionVWAP, rollingAvgVolume } = require('../lib/indicators');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'];

// Underlying-move bracket that approximates the option-level +50%/-35% 0DTE bracket
// (ATM 0DTE premium ~0.3-0.6% of spot, delta ~0.5 → ~0.30% underlying ≈ +50% option).
const DEFAULT_TP = 0.0030;
const DEFAULT_SL = 0.0021;

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

function etParts(bar) {
  const d = new Date(bar.t);
  const day = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  return { day, time };
}

// Precompute indicators once per symbol; signals are re-filtered per parameter combo.
function extractRawSignals(bars) {
  const minWarmup = cfg.EMA_SLOW + cfg.VOLUME_LOOKBACK + 2;
  const closes = bars.map((b) => b.c);
  const fast = ema(closes, cfg.EMA_FAST);
  const slow = ema(closes, cfg.EMA_SLOW);
  const vwap = sessionVWAP(bars);
  const avgVol = rollingAvgVolume(bars, cfg.VOLUME_LOOKBACK);
  const parts = bars.map(etParts);

  const signals = [];
  for (let i = minWarmup; i < bars.length - 1; i++) {
    if ([fast[i - 1], slow[i - 1], fast[i], slow[i], vwap[i], avgVol[i]].some((v) => v == null)) continue;
    const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    if (!crossedUp && !crossedDown) continue;
    const price = closes[i];
    let direction = null;
    if (crossedUp && price > vwap[i]) direction = 'bullish';
    else if (crossedDown && price < vwap[i]) direction = 'bearish';
    if (!direction) continue;
    const rvol = avgVol[i] > 0 ? bars[i].v / avgVol[i] : 0;
    signals.push({ i, direction, price, rvol, day: parts[i].day, time: parts[i].time });
  }
  return { signals, bars, parts };
}

// First-hit bracket sim on underlying bars within the same session.
// Conservative: if both TP and SL levels fall inside one bar's range, count it a loss.
// No hit by session end -> exit at last same-day close.
function simulate(sig, bars, parts, tp, sl) {
  const entry = sig.price;
  const isBull = sig.direction === 'bullish';
  const tpLevel = isBull ? entry * (1 + tp) : entry * (1 - tp);
  const slLevel = isBull ? entry * (1 - sl) : entry * (1 + sl);
  let lastClose = entry;
  for (let j = sig.i + 1; j < bars.length; j++) {
    if (parts[j].day !== sig.day) break;
    if (parts[j].time >= '15:45') break; // force-flatten time
    const hitTP = isBull ? bars[j].h >= tpLevel : bars[j].l <= tpLevel;
    const hitSL = isBull ? bars[j].l <= slLevel : bars[j].h >= slLevel;
    if (hitSL) return -sl; // conservative on both-hit bars
    if (hitTP) return tp;
    lastClose = bars[j].c;
  }
  const move = (lastClose - entry) / entry;
  return isBull ? move : -move;
}

const TIME_WINDOWS = {
  all: () => true,
  'skip-first-15m': (t) => t >= '09:45',
  'skip-first-30m': (t) => t >= '10:00',
  'morning-only-0945-1130': (t) => t >= '09:45' && t <= '11:30',
  'no-midday-1130-1400': (t) => t < '11:30' || t >= '14:00',
  'no-midday+skip-open': (t) => (t >= '09:45' && t < '11:30') || t >= '14:00',
};

function evalCombo(allData, rvolMin, windowFn, tp, sl, directionFilter) {
  let wins = 0, losses = 0, timeouts = 0, pnl = 0;
  const perDir = { bullish: { n: 0, pnl: 0 }, bearish: { n: 0, pnl: 0 } };
  for (const { signals, bars, parts } of allData) {
    for (const sig of signals) {
      if (sig.rvol < rvolMin) continue;
      if (!windowFn(sig.time)) continue;
      if (directionFilter && sig.direction !== directionFilter) continue;
      const r = simulate(sig, bars, parts, tp, sl);
      pnl += r;
      perDir[sig.direction].n += 1;
      perDir[sig.direction].pnl += r;
      if (r === tp) wins++;
      else if (r === -sl) losses++;
      else timeouts++;
    }
  }
  const n = wins + losses + timeouts;
  return { n, wins, losses, timeouts, pnl, expectancy: n ? pnl / n : 0, perDir };
}

async function main() {
  const days = parseInt(process.argv[2] || '60', 10);
  console.log(`Fetching ${days} days of 5-min bars for ${SYMBOLS.length} symbols...`);
  const allData = [];
  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const extracted = extractRawSignals(bars);
    console.log(`${symbol}: ${bars.length} bars, ${extracted.signals.length} raw crossover signals`);
    allData.push(extracted);
  }

  console.log('\n=== Sweep: RVOL x time-window (bracket tp=0.30% sl=0.21% on underlying) ===');
  const rows = [];
  for (const rvolMin of [1.0, 1.5, 2.0, 2.5, 3.0]) {
    for (const [wname, wfn] of Object.entries(TIME_WINDOWS)) {
      const r = evalCombo(allData, rvolMin, wfn, DEFAULT_TP, DEFAULT_SL, null);
      rows.push({
        rvol: rvolMin,
        window: wname,
        n: r.n,
        winRate: r.n ? ((r.wins / r.n) * 100).toFixed(1) : '-',
        'exp(bp)': (r.expectancy * 10000).toFixed(2),
        'totPnl(%)': (r.pnl * 100).toFixed(2),
        'bull n/pnl%': `${r.perDir.bullish.n}/${(r.perDir.bullish.pnl * 100).toFixed(2)}`,
        'bear n/pnl%': `${r.perDir.bearish.n}/${(r.perDir.bearish.pnl * 100).toFixed(2)}`,
      });
    }
  }
  console.table(rows);

  console.log('\n=== Direction-only splits at rvol>=1.5, all hours ===');
  for (const dir of ['bullish', 'bearish']) {
    const r = evalCombo(allData, 1.5, TIME_WINDOWS.all, DEFAULT_TP, DEFAULT_SL, dir);
    console.log(`${dir}: n=${r.n} winRate=${r.n ? ((r.wins / r.n) * 100).toFixed(1) : '-'}% exp=${(r.expectancy * 10000).toFixed(2)}bp`);
  }

  console.log('\n=== Bracket sweep on best-looking filters (fill in after first pass) ===');
  for (const [tp, sl] of [[0.002, 0.0014], [0.003, 0.0021], [0.004, 0.0028], [0.005, 0.0035], [0.003, 0.003], [0.004, 0.002]]) {
    for (const rvolMin of [1.5, 2.0]) {
      const r = evalCombo(allData, rvolMin, TIME_WINDOWS['no-midday+skip-open'], tp, sl, null);
      console.log(`tp=${(tp * 100).toFixed(2)}% sl=${(sl * 100).toFixed(2)}% rvol>=${rvolMin} window=no-midday+skip-open: n=${r.n} winRate=${r.n ? ((r.wins / r.n) * 100).toFixed(1) : '-'}% exp=${(r.expectancy * 10000).toFixed(2)}bp tot=${(r.pnl * 100).toFixed(2)}%`);
    }
  }
}

main().catch((e) => console.error('FAIL', e.message, e.stack));
