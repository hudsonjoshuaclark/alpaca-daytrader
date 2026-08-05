// Standalone Alpaca client for trader-mimicry - own copy, same reasoning as
// strategies/overnight-drift/alpacaClient.js: zero chance of picking up another bot's
// credentials via a shared module.
const cfg = require('./config');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_429_RETRIES = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(base, path, { method = 'GET', params, body } = {}, attempt = 0) {
  const url = new URL(base + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

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

  if (res.status === 429 && attempt < MAX_429_RETRIES) {
    const waitMs = 2000 * 2 ** attempt;
    await sleep(waitMs);
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
