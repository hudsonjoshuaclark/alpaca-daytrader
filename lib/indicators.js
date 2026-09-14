function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      prev = seed;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Session VWAP: resets each new trading day (bars carry ISO timestamps in UTC)
function sessionVWAP(bars) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumVol = 0;
  let currentDay = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const dayKey = new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * b.v;
    cumVol += b.v;
    out[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return out;
}

function rollingAvgVolume(bars, period) {
  const out = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (i < period) continue;
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += bars[j].v;
    out[i] = sum / period;
  }
  return out;
}

// Average True Range (Wilder smoothing) over daily bars — volatility measure
function atr(bars, period) {
  if (bars.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const prevClose = bars[i - 1].c;
    trueRanges.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  let atrVal = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
  }
  return atrVal;
}

// Wilder's RSI. Returns an array aligned to `values`, null until the seed window fills.
function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD: fast EMA - slow EMA, plus an EMA-smoothed signal line and the histogram (macd - signal).
// Uses this file's own ema() so all three lines share identical seeding behavior.
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = values.map((_, i) => (fastEma[i] != null && slowEma[i] != null) ? fastEma[i] - slowEma[i] : null);
  const firstValid = macdLine.findIndex((v) => v !== null);
  const signalLine = new Array(values.length).fill(null);
  if (firstValid !== -1) {
    const compact = macdLine.slice(firstValid);
    const signalCompact = ema(compact, signalPeriod);
    for (let i = 0; i < compact.length; i++) signalLine[firstValid + i] = signalCompact[i];
  }
  const histogram = values.map((_, i) => (macdLine[i] != null && signalLine[i] != null) ? macdLine[i] - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

module.exports = { ema, sessionVWAP, rollingAvgVolume, atr, rsi, macd };
