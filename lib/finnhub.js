// Read-only Finnhub client - free tier (60 calls/min, no credit card). Requires
// FINNHUB_API_KEY in .env. Not wired into any bot's trading logic yet; this is just the
// reusable client so it's ready for whichever use case gets picked (dashboard cross-check,
// backtest research, etc.) - same "diagnostics first, live logic needs backtest evidence"
// rule as everything else in this project.
const REQUEST_TIMEOUT_MS = 8000;
const BASE = 'https://finnhub.io/api/v1';

function apiKey() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('Missing FINNHUB_API_KEY (run node with --env-file=.env)');
  return key;
}

async function request(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('token', apiKey());

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// { price, change, changePct, high, low, open, prevClose, asOf } or null on failure.
async function getQuote(symbol) {
  const q = await request('/quote', { symbol });
  if (!q || typeof q.c !== 'number' || q.c === 0) return null; // Finnhub returns all-zero on an invalid/unknown symbol
  return {
    price: q.c, change: q.d, changePct: q.dp, high: q.h, low: q.l, open: q.o, prevClose: q.pc,
    asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
  };
}

// Basic company info (name, industry, market cap) - useful for research, not signals.
async function getCompanyProfile(symbol) {
  const p = await request('/stock/profile2', { symbol });
  if (!p || !p.name) return null;
  return p;
}

module.exports = { getQuote, getCompanyProfile };
