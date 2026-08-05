// Config for the 0DTE put credit spread strategy - fully isolated, own env var names.
// Validated 2026-07-31 (scripts/strategy-creditspread-sweep.js, 180 days, n=247,
// well past this project's 200-trade evidentiary bar): 71.7% win rate, +168.01bp
// expectancy (of max risk). Per-symbol: SPY 71.0%/n=124, QQQ 72.4%/n=123 - consistent
// between both. Monthly: 5 of 6 months positive (beats ORB-15's own "3 of 4" bar), but
// the most recent month (July 2026) was NEGATIVE (-159.29bp) - a real, not hypothetical,
// losing stretch happened right before this went live. High win rate does not mean smooth
// - it means frequent small wins punctuated by real losses (worst trades tested: -34% to
// -54% of max risk, still bounded by the defined-risk spread structure).
const KEY_ID = process.env.APCA_CREDITSPREAD_API_KEY_ID;
const SECRET_KEY = process.env.APCA_CREDITSPREAD_SECRET_KEY;

if (!KEY_ID || !SECRET_KEY) {
  throw new Error('Missing APCA_CREDITSPREAD_API_KEY_ID / APCA_CREDITSPREAD_SECRET_KEY (run node with --env-file=strategies/credit-spread/.env.creditspread)');
}

module.exports = {
  KEY_ID,
  SECRET_KEY,
  TRADING_BASE: 'https://paper-api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  headers: {
    'APCA-API-KEY-ID': KEY_ID,
    'APCA-API-SECRET-KEY': SECRET_KEY,
  },

  // --- Strategy parameters, matching the validated backtest exactly ---
  SYMBOLS: ['SPY', 'QQQ'], // only these two reliably have real 0DTE (same-day expiration) options
  SHORT_OTM_PCT: 0.01, // short put target ~1% OTM at the open
  WIDTH: 3, // $ between short and long (protective) put strikes
  PROFIT_TARGET_PCT: 0.50, // close at 50% of max credit captured
  STOP_MULTIPLE: 2.0, // close if spread value grows to 2x credit received (loss)
  ENTRY_WINDOW_START: '09:35', // ET, a few minutes after the open once quotes settle
  ENTRY_WINDOW_END: '10:00', // ET, don't chase an entry much past the open
  FORCE_CLOSE_AT: '15:45', // ET, same flatten discipline as the other bots - 0DTE assignment risk if held into the close

  // --- Risk ---
  // Budget-based sizing (like the other bots) doesn't work cleanly here: at $3 width, max
  // risk per contract is typically $200-280 (width minus credit received, x100) - already
  // 20-28% of this $1000 account for a SINGLE contract. Fixed qty=1 per spread per symbol
  // instead, with a live safety check that skips entry if the day's actual max risk would
  // exceed MAX_RISK_PCT_OF_EQUITY.
  QTY_PER_SPREAD: 1,
  MAX_RISK_PCT_OF_EQUITY: 0.30,
  MAX_CONCURRENT_POSITIONS: 2, // naturally capped - only SPY and QQQ are traded
  PAUSE_DRAWDOWN_PCT: 0.25,

  // Contract selection liquidity gates, same convention as the other bots
  MAX_SPREAD_PCT: 10, // 0DTE ATM-adjacent puts are usually tight, but allow a bit more than the other bots' 8%
  MIN_OPEN_INTEREST: 50, // 0DTE OI builds through the day - the other bots' 100 threshold is tuned for weeklies
};
