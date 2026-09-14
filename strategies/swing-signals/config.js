// ############################################################################
// # RETIRED 2026-08-14. This bot is stopped, its scheduled task              #
// # (AlpacaSwingSignalsRunner) is DISABLED, and its account now runs         #
// # strategies/overnight-momentum/ instead. Do not restart it without        #
// # reading the measurement below - it has no demonstrated edge.             #
// # Code and logs are kept for history, not for use.                         #
// ############################################################################
//
// Config for the RSI-pullback swing-signal strategy - fully isolated, own env var names.
//
// !!!! 2026-08-13 - THIS STRATEGY HAS NO DEMONSTRATED EDGE AS DEPLOYED. Measured, not
// suspected: scripts/strategy-swing-signalrate-sweep.js re-ran 365 days x 56 symbols
// counting ONLY signals inside the live entry window, and the deployed setting
// (ema=50, rsi=30, win=09:45) scores n=18 over 251 trading days -> 18 trades/YEAR at
// +0.1bp/trade. Not a small edge - indistinguishable from zero, on a sample an order of
// magnitude below this project's 200-trade bar. That matches live behaviour exactly: ZERO
// trades taken in the 11 sessions since deployment. The time-of-day breakdown reproduced
// the 2026-08-03 finding below almost exactly (5.2% of raw signals in-window vs 5.5%).
//
// A 24-combo grid over RSI threshold (30/35/40/45), window start (09:35/09:45/10:00) and
// trend EMA (50/20) found NO deployable replacement:
//   - rsi=35 looks best on the surface (n=177, +7.6bp, 53.1% wins) but its edge is entirely
//     in the last 30% of the sample - in-sample expectancy is NEGATIVE (-3.4bp). That is a
//     regime artifact, not an edge.
//   - rsi=45/ema=20 rows pass a naive statistical filter but demand ~16,000 trades/year
//     (63/day on a $1000 account) at +1.0bp with 330% max drawdown - below transaction
//     cost and untradeable.
// Nothing was changed on this evidence: "no change" beats deploying a fitted variant.
// The real options are to retire this bot or replace the strategy outright - a human call.
// See SESSION-AUDIT-2026-08-13.md.
//
// The pre-existing 2026-08-02 header follows, kept because it documents how the invalid
// n=324 figure was produced. Treat every number in it as SUPERSEDED by the above.
// Validated 2026-08-02 (scripts/strategy-swing-sweep.js, 365 real days, n=324, clears this
// project's 200-trade bar): signal = price above EMA(50) (uptrend filter) + RSI(14) crosses
// back up through 30 (pullback entry), on the lib/watchlist.js universe. Two stop/target
// regimes were tested; a WIDE one (5%/12%) had the highest raw expectancy (46.48bp/trade)
// but 95% of trades never touched either threshold - they just rode to the forced EOD
// flatten, making the "stop/target" mostly a dormant tail-risk backstop rather than the
// thing actually closing trades. The BALANCED regime below (1.5%/2.0%) is what's deployed
// instead, deliberately chosen over the higher-expectancy option: stop and target genuinely
// drive most exits (113 stops / 105 targets / 106 EOD out of 324 - close to an even three-
// way split), which is what was actually asked for (active stop-loss/take-profit discipline,
// not a rarely-triggered safety net). Real numbers: 20.24bp/trade expectancy, 51.9% win rate,
// +65.58% summed return over the sample, 7/12 months positive. March 2026 was a real losing
// month (-32.51bp) - also seen across nearly every other candidate/bot backtested in this
// project that month, so it reads as a market-wide event, not a flaw specific to this signal.
// Trades direct stock shares (not options) via Alpaca's plain /v2/orders endpoint - simpler
// than every other bot here, no contract selection needed.
// !! 2026-08-03: THE n=324 SAMPLE ABOVE IS NOT WHAT THIS BOT TRADES. Measured with
// scripts/strategy-swing-ratchet-sweep.js over the same 365 days / 56 symbols, the signal
// falls by time of day as:
//     pre-market   <09:30      80   23.3%
//     09:30-09:45 (open)      224   65.1%
//     09:45-15:30 (LIVE)       19    5.5%   <- all this bot can actually take
//     15:30-16:00 (close)       5    1.5%
//     after-hours  >=16:00     16    4.7%
// strategy-swing-sweep.js filters only on `time < '15:45'`, so it counts pre-market and
// opening-15-minute bars; ENTRY_WINDOW_START below rules both out. 94.5% of the validating
// sample is untradeable by this bot, which should therefore take ~19 trades/YEAR, not 324.
// Cause: RSI(14)<=30 needs a sharp drop, which almost always puts price under EMA(50), so
// "pullback in an uptrend" only co-occurs where the continuously-computed indicator series
// jumps the overnight gap - i.e. at the open. The expectancy/win-rate figures above should
// be treated as unvalidated for live behaviour until the sweep respects the entry window.
const KEY_ID = process.env.APCA_SWING_API_KEY_ID;
const SECRET_KEY = process.env.APCA_SWING_SECRET_KEY;

if (!KEY_ID || !SECRET_KEY) {
  throw new Error('Missing APCA_SWING_API_KEY_ID / APCA_SWING_SECRET_KEY (run node with --env-file=strategies/swing-signals/.env.swing)');
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
  TIMEFRAME: '5Min',
  EMA_TREND: 50,
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 30,
  STOP_LOSS_PCT: 0.015,
  TAKE_PROFIT_PCT: 0.02,

  // --- Ratcheting stop/target (lib/ratchet.js) ---
  // ON: reaching TAKE_PROFIT_PCT no longer closes the trade, it advances a rung and sets a
  // new stop/target pair 2% higher (stop trails 1.5% under the last target reached), so
  // rung 1 onward is a locked-in profit. OFF: the original close-at-target behaviour, which
  // is what the 2026-08-02 backtest above actually measured.
  // NOT YET BACKTESTED - this trades win rate for tail size. The 105 target-hits in that
  // sample become ratchets instead of +2.0% wins, and any that round-trip back down now
  // exit at +0.5% instead. Re-run scripts/strategy-swing-sweep.js before trusting the
  // numbers in the comment above to still describe live behaviour.
  RATCHET_ENABLED: true,
  RATCHET_MAX_RUNGS: 100, // effectively uncapped for an intraday hold; bounds a bad quote

  ENTRY_WINDOW_START: '09:45', // ET, a few minutes after the open once the 50-bar EMA/RSI warmup + quotes settle
  ENTRY_WINDOW_END: '15:30', // ET, don't open a new swing too close to the flatten
  FORCE_CLOSE_AT: '15:45', // ET, same flatten discipline as every other bot - day trading, no overnight carry

  // --- Risk ---
  // Smaller per-trade % than the single-position bots since this one can hold several
  // positions across different symbols at once - total exposure is what matters.
  RISK_PCT_PER_TRADE: 0.12,
  MAX_CONCURRENT_POSITIONS: 5,
  MAX_TRADES_PER_DAY: 8, // new pattern for this project - a same-day entry-count throttle, since the signal can in principle fire on many watchlist symbols in one session
  PAUSE_DRAWDOWN_PCT: 0.30,
  DAILY_LOSS_STOP_PCT: 0.20, // this bot trades multiple times/day, so a same-day circuit breaker matters more here than for the single-shot bots
};
