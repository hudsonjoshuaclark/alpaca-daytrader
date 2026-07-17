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

module.exports = { ema, sessionVWAP, rollingAvgVolume, atr };
