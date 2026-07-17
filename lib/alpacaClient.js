const cfg = require('./config');

const REQUEST_TIMEOUT_MS = 20000;

async function request(base, path, { method = 'GET', params, body } = {}) {
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
    throw e;
  } finally {
    clearTimeout(timeoutId);
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
