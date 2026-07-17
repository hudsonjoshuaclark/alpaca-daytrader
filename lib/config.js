// LIVE_MODE: which account/endpoint to hit (paper vs real money). Independent of
// how trades are sized/gated — see SMALL_ACCOUNT_MODE below.
const LIVE_MODE = process.env.LIVE_MODE === 'true';

// SMALL_ACCOUNT_MODE: which risk/sizing rules to use (%-of-equity budget, 2 concurrent
// positions, % daily loss stop, drawdown pause) vs the legacy %-of-portfolio rules built
// for the original $100k paper account. Going live always implies small-account rules.
const SMALL_ACCOUNT_MODE = LIVE_MODE || process.env.SMALL_ACCOUNT_MODE === 'true';

const KEY_ID = LIVE_MODE ? process.env.APCA_LIVE_API_KEY_ID : process.env.APCA_API_KEY_ID;
const SECRET_KEY = LIVE_MODE ? process.env.APCA_LIVE_SECRET_KEY : process.env.APCA_API_SECRET_KEY;

if (!KEY_ID || !SECRET_KEY) {
  const which = LIVE_MODE ? 'APCA_LIVE_API_KEY_ID / APCA_LIVE_SECRET_KEY' : 'APCA_API_KEY_ID / APCA_API_SECRET_KEY';
  throw new Error(`Missing ${which} (run node with --env-file=.env)`);
}

module.exports = {
  LIVE_MODE,
  SMALL_ACCOUNT_MODE,
  KEY_ID,
  SECRET_KEY,
  TRADING_BASE: LIVE_MODE ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  headers: {
    'APCA-API-KEY-ID': KEY_ID,
    'APCA-API-SECRET-KEY': SECRET_KEY,
  },

  // --- Strategy: 15-min Opening Range Breakout (replaced EMA9/21 crossover) ---
  // Chosen from a 90-120 day sweep over 5-min bars (scripts/sweep*.js):
  //  - EMA crossover: negative expectancy in EVERY tested configuration (-0.7 to -3.6bp/trade)
  //  - ORB-15 rvol>=1.5 on liquid large-caps: +8.1bp/trade pooled (n=603), positive 3 of 4
  //    months, both directions, and improves with earlier entry cutoff (+14.3bp before 11:00)
  //  - Daily "hot name" screener gating made results WORSE (-21.6bp) — retired from entry path
  // Static liquid universe (pooled-positive cohort; options tradeable via singles or spreads):
  UNIVERSE: ['TSLA', 'META', 'MSFT', 'AAPL', 'AMZN', 'NVDA', 'COIN', 'MSTR', 'PLTR', 'AMD', 'SPY', 'QQQ'],
  ORB_MINUTES: 15, // opening range = first three 5-min bars (09:30-09:45 ET)
  ORB_RVOL_MIN: 1.5, // breakout bar volume must be >= 1.5x the 20-bar average
  ORB_ENTRY_CUTOFF: '11:30', // ET; sweep3: expectancy decays for later breakouts
  TIMEFRAME: '5Min',
  VOLUME_LOOKBACK: 20,
  FORCE_FLATTEN_AT: '15:45', // ET, exit everything before close
  // Exit model (matches what was backtested): stop when the underlying crosses back
  // through the opening-range midpoint, otherwise hold to the force-flatten time.
  // No profit target — winners run to end of day (avg win 1.2% underlying vs 0.79% loss).
  OPTION_STOP_PCT: 0.55, // catastrophic backstop on combined premium (theta/IV crush protection)
  ENTRY_ORDER_TTL_MS: 2 * 60 * 1000, // cancel unfilled entry limit orders after this long

  // Contract selection
  MAX_SPREAD_PCT: 8, // skip entry if a leg's bid-ask spread exceeds this % of mid
  MIN_OPEN_INTEREST: 100,
  SPREAD_SHORT_STRIKE_OTM_PCT: 0.012, // debit-spread short leg target: ~1.2% OTM

  // --- Small-account rules (active whenever SMALL_ACCOUNT_MODE is true) ---
  // Aggressive by design: user goal is maximum growth of a $1000 account (paper).
  RISK_PCT_PER_TRADE: 0.30, // premium budget per trade = 30% of current equity
  MAX_CONCURRENT_POSITIONS: 2, // account-wide
  DAILY_LOSS_STOP_PCT: 0.25, // stop entering after losing 25% of day-start equity
  PAUSE_DRAWDOWN_PCT: 0.35, // pause everything if equity falls 35% below initial capital

  // --- Legacy large-account (%-of-$100k) rules, used when SMALL_ACCOUNT_MODE is false ---
  RISK_PER_TRADE_PCT: 0.04,
  MAX_DAILY_LOSS_PCT: 0.06,

  // Explicit env var always wins; otherwise default true for real money (LIVE_MODE),
  // false for paper (no reason to gate fake trades).
  SMALL_ACCOUNT_REQUIRE_MANUAL_APPROVAL:
    process.env.SMALL_ACCOUNT_REQUIRE_MANUAL_APPROVAL != null
      ? process.env.SMALL_ACCOUNT_REQUIRE_MANUAL_APPROVAL === 'true'
      : LIVE_MODE,

  // --- Legacy params kept for scripts/backtest.js, scripts/sweep*.js, stress-test ---
  SYMBOLS: ['SPY', 'QQQ'],
  EMA_FAST: 9,
  EMA_SLOW: 21,
  RVOL_THRESHOLD: 1.5,
  NO_NEW_ENTRIES_AFTER: '11:30', // superseded by ORB_ENTRY_CUTOFF; kept for old scripts
};
