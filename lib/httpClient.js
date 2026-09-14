// Shared Alpaca HTTP transport: URL building, timeouts, and the retry policy. This module
// holds NO config and NO credentials of its own - `createAlpacaClient(cfg)` binds a caller's
// config to a client instance, so each strategy still talks to its own account. That was the
// point of the four hand-copied clients this replaces (lib/, credit-spread, swing-signals,
// overnight-drift); passing cfg in preserves the isolation without the duplication.
//
// Why collapse them: the copies had drifted to four byte-different files that were
// semantically identical apart from comments, and the drift had already caused a real
// incident - the 2026-07-28 network-retry fix was applied only to lib/, so on 2026-08-05
// the three strategy copies still failed on bare "fetch failed" during a broker outage.
// Same reasoning as lib/ratchet.js, which swing-signals already shares: config-free logic
// is safe to share; anything that touches credentials is not.

const REQUEST_TIMEOUT_MS = 20000;
const MAX_429_RETRIES = 4;
const MAX_NETWORK_RETRIES = 2; // DNS blips / connection resets are usually transient
const MAX_5XX_RETRIES = 3;
// A request that hangs past the timeout is usually a stalled connection, not a broker
// refusal, so one retry recovers it. Bounded at 1 (worst case ~40s for a single GET)
// because the runners' tick re-entrancy guard has to absorb it. Before this, a timeout
// threw straight through and aborted the whole tick: on 2026-08-13 swing-signals lost 16
// consecutive minutes of position management to /v2/account timing out every tick.
const MAX_TIMEOUT_RETRIES = 1;
// Alpaca fronts its API with nginx, and a broker-side blip surfaces as an HTML 5xx page
// rather than a JSON error. On 2026-08-05 a ~5-minute burst of these hit all three
// continuous runners at once and aborted every tick it touched, because only 429s were
// retried. The scheduled-task bots are even more exposed - overnight-drift gets two shots
// a day (enter 15:55, exit 09:35), so an unretried blip loses a whole decision point.
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only GETs are retried automatically. A POST/DELETE that fails mid-flight may already
// have been accepted by Alpaca (an order placed, a position closed) with only the
// response lost, so a blind retry risks duplicating a live trade. Mutating calls
// therefore surface the first failure; every caller runs inside a polling tick or a
// scheduled run that re-attempts the action next pass, which is the safe way to recover.
function isRetryableMethod(method) {
  return method === 'GET';
}

function createAlpacaClient(cfg) {
  if (!cfg || !cfg.headers || !cfg.TRADING_BASE || !cfg.DATA_BASE) {
    throw new Error('createAlpacaClient: config must provide headers, TRADING_BASE and DATA_BASE');
  }

  async function request(base, path, opts = {}, attempt = 0) {
    const { method = 'GET', params, body } = opts;
    const url = new URL(base + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
    }

    // Without an explicit timeout, a single hung/stalled connection blocks this call (and
    // whatever awaited it) forever - found via a stress-test run that sat for 61 minutes of
    // wall-clock time using ~1s of actual CPU (i.e. stuck waiting, not computing).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    let failure = null;
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
      failure = e;
    } finally {
      // Cleared before any retry, so a retry never runs under the previous attempt's timer.
      clearTimeout(timeoutId);
    }

    if (failure) {
      const timedOut = failure.name === 'AbortError';
      const budget = timedOut ? MAX_TIMEOUT_RETRIES : MAX_NETWORK_RETRIES;
      if (isRetryableMethod(method) && attempt < budget) {
        await sleep(500 * 2 ** attempt);
        return request(base, path, opts, attempt + 1);
      }
      if (timedOut) {
        throw new Error(`Alpaca ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      // Node's fetch collapses DNS/connection-level failures into a generic "fetch failed"
      // and puts the actual cause (ECONNRESET, ENOTFOUND, etc.) on e.cause, which was being
      // dropped entirely - logs only ever showed the useless top-level message.
      const cause = failure.cause ? (failure.cause.code || failure.cause.message || String(failure.cause)) : failure.message;
      throw new Error(`Alpaca ${method} ${path} network error after ${attempt + 1} attempts: ${cause}`);
    }

    // 429s showed up repeatedly during heavy backtest-script usage (many paginated
    // multi-symbol bar fetches back to back) - a short exponential backoff clears these
    // without needing a human to notice and manually retry. Also protects the live runners
    // if one ever gets rate-limited during a burst (e.g. after a reconnect).
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      await sleep(2000 * 2 ** attempt);
      return request(base, path, opts, attempt + 1);
    }

    // Transient broker-side 5xx: back off and retry rather than killing the tick. Worst
    // case adds ~7s (1s + 2s + 4s) to a single GET, which the tick re-entrancy guard in
    // the runners is sized to absorb.
    if (RETRYABLE_5XX.has(res.status) && isRetryableMethod(method) && attempt < MAX_5XX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      return request(base, path, opts, attempt + 1);
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

  return {
    trading: (path, opts) => request(cfg.TRADING_BASE, path, opts),
    data: (path, opts) => request(cfg.DATA_BASE, path, opts),
  };
}

module.exports = { createAlpacaClient, REQUEST_TIMEOUT_MS };
