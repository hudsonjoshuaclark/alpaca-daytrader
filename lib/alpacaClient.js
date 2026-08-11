const cfg = require('./config');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_429_RETRIES = 4;
const MAX_NETWORK_RETRIES = 2; // DNS blips / connection resets are usually transient
const MAX_5XX_RETRIES = 3;
// Alpaca fronts its API with nginx, and a broker-side blip surfaces as an HTML 5xx page
// rather than a JSON error. On 2026-08-05 a ~5-minute burst of these hit all three
// runners at once and aborted every tick it touched, because only 429s were retried.
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only GETs are retried automatically. A POST/DELETE that fails mid-flight may already
// have been accepted by Alpaca (an order placed, a position closed) with only the
// response lost, so a blind retry risks duplicating a live trade. Mutating calls
// therefore surface the first failure; every caller runs inside a polling tick that
// re-attempts the action next pass, which is the safe way to recover.
function isRetryableMethod(method) {
  return method === 'GET';
}

async function request(base, path, { method = 'GET', params, body } = {}, attempt = 0) {
  const url = new URL(base + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  // Without an explicit timeout, a single hung/stalled connection blocks this call
  // (and whatever awaited it) forever — found via a stress-test run that sat for
  // 61 minutes of wall-clock time using ~1s of actual CPU (i.e. stuck waiting, not computing).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...cfg.headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Alpaca ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    // Node's fetch collapses DNS/connection-level failures into a generic "fetch failed"
    // and puts the actual cause (ECONNRESET, ENOTFOUND, etc.) on e.cause, which was being
    // dropped entirely — logs only ever showed the useless top-level message.
    const cause = e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : e.message;
    if (isRetryableMethod(method) && attempt < MAX_NETWORK_RETRIES) {
      await sleep(500 * 2 ** attempt);
      return request(base, path, { method, params, body }, attempt + 1);
    }
    throw new Error(`Alpaca ${method} ${path} network error after ${attempt + 1} attempts: ${cause}`);
  } finally {
    clearTimeout(timeoutId);
  }

  // 429s showed up repeatedly during heavy backtest-script usage (many paginated
  // multi-symbol bar fetches back to back) - a short exponential backoff clears these
  // without needing a human to notice and manually retry. Also protects the live runner
  // if it ever gets rate-limited during a burst (e.g. after a reconnect).
  if (res.status === 429 && attempt < MAX_429_RETRIES) {
    const waitMs = 2000 * 2 ** attempt;
    await sleep(waitMs);
    return request(base, path, { method, params, body }, attempt + 1);
  }

  // Transient broker-side 5xx: back off and retry rather than killing the tick. Worst
  // case adds ~7s (1s + 2s + 4s) to a single GET, which the tick re-entrancy guard in
  // the runners is sized to absorb.
  if (RETRYABLE_5XX.has(res.status) && isRetryableMethod(method) && attempt < MAX_5XX_RETRIES) {
    await sleep(1000 * 2 ** attempt);
    return request(base, path, { method, params, body }, attempt + 1);
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`Alpaca ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

module.exports = {
  trading: (path, opts) => request(cfg.TRADING_BASE, path, opts),
  data: (path, opts) => request(cfg.DATA_BASE, path, opts),
};
