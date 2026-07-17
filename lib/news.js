const fs = require('fs');
const path = require('path');
const client = require('./alpacaClient');

const STATE_FILE = path.join(__dirname, '..', 'logs', 'news-state.json');
const INITIAL_LOOKBACK_MS = 15 * 60 * 1000; // first run: only look back 15 min, not the whole day
const MAX_PROCESSED_IDS = 500; // bound file growth

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { lastCheckedAt: null, processedIds: [] };
}

function saveState(state) {
  if (state.processedIds.length > MAX_PROCESSED_IDS) {
    state.processedIds = state.processedIds.slice(-MAX_PROCESSED_IDS);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Returns new, not-yet-seen articles (each { id, headline, symbols, created_at, source, url })
// since the last check, for the given symbol list. Updates persisted state so the same
// article never gets acted on twice.
async function getNewArticles(symbols) {
  const state = loadState();
  const start = state.lastCheckedAt || new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();

  const res = await client.data('/v1beta1/news', {
    params: { symbols: symbols.join(','), start, limit: 50, sort: 'asc' },
  });
  const articles = res.news || [];

  const processedSet = new Set(state.processedIds);
  const newArticles = articles.filter((a) => !processedSet.has(a.id));

  state.lastCheckedAt = new Date().toISOString();
  state.processedIds = [...state.processedIds, ...newArticles.map((a) => a.id)];
  saveState(state);

  return newArticles.map((a) => ({
    id: a.id,
    headline: a.headline,
    symbols: a.symbols,
    createdAt: a.created_at,
    source: a.source,
    url: a.url,
  }));
}

module.exports = { getNewArticles };
