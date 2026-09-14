// Free retail-attention/sentiment signals as a proxy for "what traders are watching."
// There is no legitimate free (or even affordable) feed of real day traders' actual live
// fills — professional traders don't publish those. StockTwits' public API (no auth
// required for these endpoints, verified against real traffic 2026-07-28) is the closest
// free approximation: trending tickers + explicit Bullish/Bearish tags traders attach to
// their own posts. Treat this as crowd attention/sentiment, not a verified "smart money"
// signal — the advisory report built from this should say so.
const STOCKTWITS_BASE = 'https://api.stocktwits.com/api/2';
const HEADERS = { 'User-Agent': 'alpaca-daytrader-advisor/1.0 (personal research script)' };

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Trending symbols across all of StockTwits right now, ranked by their trending_score.
async function fetchTrending() {
  const data = await fetchJson(`${STOCKTWITS_BASE}/trending/symbols.json`);
  return (data.symbols || []).map((s) => ({ symbol: s.symbol, trendingScore: s.trending_score }));
}

// Recent top messages for one symbol, reduced to a sentiment/velocity summary.
// Only messages where the author explicitly tagged Bullish/Bearish count toward sentiment
// (most messages carry no tag) — untagged messages still count toward volume.
async function fetchSymbolSentiment(symbol, limit = 30) {
  const data = await fetchJson(`${STOCKTWITS_BASE}/streams/symbol/${encodeURIComponent(symbol)}.json?filter=top`);
  const messages = (data.messages || []).slice(0, limit);
  let bullish = 0;
  let bearish = 0;
  for (const m of messages) {
    const tag = m.entities && m.entities.sentiment && m.entities.sentiment.basic;
    if (tag === 'Bullish') bullish++;
    else if (tag === 'Bearish') bearish++;
  }
  return {
    symbol,
    messageCount: messages.length,
    bullish,
    bearish,
    sampleBodies: messages.slice(0, 5).map((m) => m.body),
  };
}

// For a watchlist, find which symbols are currently trending, then pull sentiment for the
// top N of those. Deliberately capped (StockTwits' unauthenticated rate limit is modest and
// we only need a daily snapshot, not full coverage) rather than looping over every symbol.
async function gatherSignals(symbols, { topN = 8 } = {}) {
  const trending = await fetchTrending();
  const trendingSet = new Map(trending.map((t) => [t.symbol, t.trendingScore]));
  const inUniverse = symbols
    .filter((s) => trendingSet.has(s))
    .sort((a, b) => trendingSet.get(b) - trendingSet.get(a));

  const targets = inUniverse.slice(0, topN);
  const sentiment = [];
  for (const symbol of targets) {
    try {
      // Sequential, not Promise.all — be polite to an unauthenticated public API.
      sentiment.push(await fetchSymbolSentiment(symbol));
    } catch (e) {
      sentiment.push({ symbol, error: e.message });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    trendingInUniverse: inUniverse.map((s) => ({ symbol: s, trendingScore: trendingSet.get(s) })),
    sentiment,
  };
}

module.exports = { fetchTrending, fetchSymbolSentiment, gatherSignals };
