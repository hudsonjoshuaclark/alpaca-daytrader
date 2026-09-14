// Read-only cross-check against Yahoo Finance's unofficial (undocumented, no-key) chart
// endpoint. Pure diagnostic - NOT wired into any bot's trading/signal logic, only into the
// dashboard, so it needs no backtest (same bar as the fill-vs-mid logging tile: additive
// visibility, doesn't change trading behavior). Yahoo's endpoint is undocumented and can
// change format or start rate-limiting without notice - every call is wrapped so a failure
// here can never take down the dashboard, it just omits that symbol's cross-check.
const REQUEST_TIMEOUT_MS = 8000;

async function getYahooPrice(symbol) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    const price = meta && typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null;
    if (price == null) return null;
    return { price, asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { getYahooPrice };
