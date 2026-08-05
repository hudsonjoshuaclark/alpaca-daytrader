// Config for the overnight close-to-open momentum drift strategy - deliberately isolated
// from ../../lib/config.js (the ORB-15 bot's config) with its OWN env var names, so there
// is no possibility of the two bots' credentials or risk parameters ever cross-wiring even
// if someone runs both from the same shell. Load with:
//   node --env-file=strategies/overnight-drift/.env.overnight strategies/overnight-drift/enter.js
const KEY_ID = process.env.APCA_OVERNIGHT_API_KEY_ID;
const SECRET_KEY = process.env.APCA_OVERNIGHT_SECRET_KEY;

if (!KEY_ID || !SECRET_KEY) {
  throw new Error('Missing APCA_OVERNIGHT_API_KEY_ID / APCA_OVERNIGHT_SECRET_KEY (run node with --env-file=strategies/overnight-drift/.env.overnight)');
}

module.exports = {
  KEY_ID,
  SECRET_KEY,
  // Always paper - this strategy has no live-mode wiring at all, unlike the ORB bot's
  // LIVE_MODE flag, so there's no accidental path to a real-money endpoint here.
  TRADING_BASE: 'https://paper-api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  headers: {
    'APCA-API-KEY-ID': KEY_ID,
    'APCA-API-SECRET-KEY': SECRET_KEY,
  },

  // --- Strategy: overnight close-to-open momentum continuation ---
  // Validated 2026-07-28 (scripts/strategy-overnight-sweep.js, 180 days): long-only
  // (buy calls after a strong up day) is positive across every threshold tested,
  // 7-16bp/trade, n=230-568. The symmetric short/put side tested NEGATIVE (-12.23bp) and
  // is deliberately NOT implemented - see IMPROVEMENTS-2026-07-28.md for the full numbers.
  UNIVERSE: ['SPY', 'QQQ', 'NVDA', 'TSLA', 'META', 'AMD', 'AAPL', 'MSFT', 'AMZN', 'COIN', 'PLTR', 'MSTR'],
  TODAY_RETURN_THRESHOLD: 0.01, // today's open->close return must be >= this to trigger (1.0% backtested cleanly across the grid)
  TIMEFRAME: '5Min',

  // --- Risk (same shape as the ORB bot's small-account rules, own values) ---
  // Overnight holds carry real gap risk the ORB bot doesn't (no intraday exit chance),
  // so sizing is more conservative than ORB's 30%/trade despite this being a lower-
  // frequency strategy.
  RISK_PCT_PER_TRADE: 0.15, // premium budget per trade = 15% of current equity
  MAX_CONCURRENT_POSITIONS: 3, // account-wide, across symbols held overnight simultaneously
  PAUSE_DRAWDOWN_PCT: 0.30, // pause everything if equity falls 30% below initial capital - manual resume only, same policy as the ORB bot

  // Contract selection - same liquidity gates as the ORB bot's lib/contracts.js
  MAX_SPREAD_PCT: 8,
  MIN_OPEN_INTEREST: 100,
  SPREAD_SHORT_STRIKE_OTM_PCT: 0.012, // debit-spread short leg target: ~1.2% OTM, same as the ORB bot
};
