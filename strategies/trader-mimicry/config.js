// Config for the trader-mimicry strategy - fully isolated from the ORB-15 and
// overnight-drift bots' configs, own env var names, own account.
//
// IMPORTANT, READ BEFORE CHANGING ANYTHING HERE: unlike ORB-15 (scripts/sweep2-4.js) and
// overnight-drift (scripts/strategy-overnight-sweep.js), there is NO BACKTEST behind this
// strategy. "What would an LLM have decided given historical insider filings and
// sentiment" isn't something this project's sweep-script harness can evaluate. Every
// number below is a conservative judgment call, not evidence - tighter than the other two
// bots on every axis (per-trade size, concurrent positions, drawdown pause) precisely
// because there's no backtest to justify anything looser. Do not loosen these based on a
// few days/weeks of live results - that's exactly the "per-day samples are noise" trap
// this whole project has otherwise avoided.
const KEY_ID = process.env.APCA_MIMICRY_API_KEY_ID;
const SECRET_KEY = process.env.APCA_MIMICRY_SECRET_KEY;

if (!KEY_ID || !SECRET_KEY) {
  throw new Error('Missing APCA_MIMICRY_API_KEY_ID / APCA_MIMICRY_SECRET_KEY (run node with --env-file=strategies/trader-mimicry/.env.mimicry)');
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

  // --- Strategy: propose from SEC Form 4 insider buys + StockTwits sentiment, a Claude
  // agent PROPOSES a trade (logs/proposal.json), a plain-code script (execute.js) reads
  // that proposal and enforces every cap below in code - the LLM never has direct
  // order-placing tool access. See AGENT-TRADER-MIMICRY.md for the agent's protocol.
  MIN_INSIDER_TXN_VALUE_USD: 100000, // ignore insider buys below this - routine/noise-level
  HOLDING_PERIOD_DAYS: 5, // trading days; exits at this point regardless of P&L if no target/stop hit first
  PROFIT_TARGET_PCT: 0.50, // close early at +50% of premium
  STOP_PCT: 0.35, // close early at -35% of premium (tighter than ORB's -55% - lower conviction, less evidence)
  MIN_EXPIRATION_DAYS_OUT: 21, // option must have at least this many days left so it survives the full hold with room to spare

  // --- Risk: deliberately tighter than both other bots on every axis ---
  RISK_PCT_PER_TRADE: 0.10, // vs ORB's 0.30, overnight-drift's 0.15
  MAX_CONCURRENT_POSITIONS: 2,
  MAX_NEW_ENTRIES_PER_DAY: 1, // hard cap regardless of how many candidates the agent finds in one day
  PAUSE_DRAWDOWN_PCT: 0.20, // vs ORB's 0.35, overnight-drift's 0.30 - pause sooner given zero backtest evidence

  // Contract selection - same liquidity gates as the other bots
  MAX_SPREAD_PCT: 8,
  MIN_OPEN_INTEREST: 100,
  SPREAD_SHORT_STRIKE_OTM_PCT: 0.012,
};
