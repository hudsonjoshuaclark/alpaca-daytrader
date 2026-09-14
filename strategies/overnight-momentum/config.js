// Overnight Momentum (SHARES) - replaces swing-signals on the same $1,000 account.
//
// WHY THIS EXISTS. swing-signals was retired 2026-08-14 for having no demonstrated edge
// (18 trades/YEAR at +0.1bp; see SESSION-AUDIT-2026-08-13.md). Four replacement searches
// were run before this one was accepted, and three were REJECTED on evidence:
//   - 6-mechanism screen (gap-down reversal, gap-up continuation, rel-strength vs SPY,
//     dip-buy, VWAP reclaim, power hour): only gap-up continuation passed the filter, and
//     it collapsed under validation - its IS/OOS agreement existed at exactly gap>=1.5%
//     and nowhere else, and the best of ~36 account configs was +4.0%/yr.
//   - ORB-15's signal traded as shares: the edge is real but lives almost entirely in the
//     12 names it already trades, and at share level it is -0.5bp after 5bp of cost. The
//     account sim lost 9-18%. ORB-15 needs options leverage to be worth running.
//   - Wider-universe retunes of swing-signals itself: nothing deployable.
//
// THE STRATEGY. At 15:55 ET buy shares of names that are up >= TODAY_RETURN_THRESHOLD from
// today's open; sell them at 09:35 ET the next session. Long only - the original overnight
// sweep tested the short side at -12.23bp and it was correctly never implemented.
//
// EVIDENCE (scripts/strategy-overnight-shares-sweep.js, 365 days, 46 symbols, 5bp assumed
// round-trip cost). n=3311, +15.7bp/trade, 50.8% win rate, IS +9.6 / OOS +29.7bp,
// 9/13 months positive. Account simulation at the deployed settings below, compounded with
// whole-share sizing: $1000 -> $1375 (+37.5%), max drawdown 5.6%, 849 trades.
//
// Why this cleared the bar when the others did not:
//   - Expectancy DECAYS SMOOTHLY across thresholds (18.9 / 19.8 / 25.2 / 29.8 / 36.0bp at
//     0.5/1.0/1.5/2.0/3.0%) - the signature of a real effect. The rejected candidates
//     spiked at one setting.
//   - Positive in-sample AND out-of-sample at EVERY threshold tested.
//   - It GENERALISES: the 46 names here exclude the 12 the options overnight-drift bot
//     trades, and score better (+20.7bp) than that bot's own universe (+15.8bp). ORB-shares
//     failed exactly this test.
//   - Every one of 12 account configurations was positive.
//   - It independently reproduces this project's own 2026-07-28 finding (+7 to +16bp/trade
//     on the underlying), on a wider and non-overlapping universe.
//
// !! HONEST CAVEATS - read before trusting the +37.5%.
//  1. MOST OF THIS IS NOT ALPHA. Holding ANY of these names overnight, unconditionally,
//     earned +12.6bp over the same sample. The up>=1.0% filter adds only +7.2bp on top.
//     The bulk of the return is the well-documented overnight risk premium, not stock
//     selection. Do not mistake this for a proprietary edge.
//  2. IT IS LONG BETA. The sample (2025-08 to 2026-08) had SPY +21.0%, of which +18.8%
//     accrued overnight. In a falling market this strategy loses money. It has never been
//     tested through a bear market.
//  3. REAL OVERNIGHT GAP TAIL. Worst single trade in the sample was -27.1%; 1st percentile
//     -6.5%. At 15% sizing a -27% gap costs ~4% of the account. This is the risk being paid
//     for, and it cannot be stopped out - the position is held while the market is closed.
//  4. Up to MAX_CONCURRENT positions are held on the SAME night, so a market-wide gap down
//     hits all of them together. The 5.6% simulated max drawdown already reflects this.
//  5. Survivorship bias: the watchlist is today's names applied to a year of history. Every
//     backtest in this project shares this limitation.
//
// Parameters were chosen to be the LEAST-FITTED option, not the best-scoring one:
// TODAY_RETURN_THRESHOLD and RISK_PCT_PER_TRADE both match the already-validated
// overnight-drift bot rather than the sweep's optimum. The sweep's best cell was risk=25%
// / max5 at +84.6%; that was deliberately NOT taken - it is the single most overfit cell
// and it doubles exposure to caveat 3.
const KEY_ID = process.env.APCA_OVERNIGHT_MOMENTUM_API_KEY_ID;
const SECRET_KEY = process.env.APCA_OVERNIGHT_MOMENTUM_SECRET_KEY;

if (!KEY_ID || !SECRET_KEY) {
  throw new Error('Missing APCA_OVERNIGHT_MOMENTUM_API_KEY_ID / APCA_OVERNIGHT_MOMENTUM_SECRET_KEY (run node with --env-file=strategies/overnight-momentum/.env.overnightmomentum)');
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

  // --- Universe -------------------------------------------------------------------------
  // lib/watchlist.js MINUS the 10 names the options overnight-drift bot trades, so the two
  // bots never hold the same stock on the same night. Deliberately additive, not a second
  // copy of an existing position. Kept as an explicit list rather than a computed filter so
  // it is auditable and cannot silently change if the shared watchlist is edited.
  UNIVERSE: [
    'GOOGL', 'AVGO', 'MU', 'SMCI', 'QCOM', 'INTC', 'ARM', 'CRM', 'ADBE', 'NOW',
    'SNOW', 'NET', 'CRWD', 'DDOG', 'PYPL', 'XYZ', 'V', 'MA', 'SOFI', 'RIVN',
    'LCID', 'F', 'GM', 'NIO', 'SHOP', 'ABNB', 'UBER', 'DASH', 'NFLX', 'DIS',
    'WBD', 'MRNA', 'NVAX', 'GME', 'AMC', 'XOM', 'CVX', 'OXY', 'JPM', 'GS',
    'BAC', 'DAL', 'UAL', 'BA', 'MARA', 'RIOT',
  ],

  // --- Strategy, matching the validated backtest exactly ----------------------------------
  TIMEFRAME: '5Min',
  TODAY_RETURN_THRESHOLD: 0.010, // buy names up >= 1.0% from today's open (same as overnight-drift)
  ENTRY_WINDOW_START: '15:55',   // ET - the backtest's entry bar
  ENTRY_WINDOW_END: '15:59',     // ET - must be in before the close; market orders, so fills are near-certain
  EXIT_AT: '09:35',              // ET next session - the backtest's exit bar
  EXIT_WINDOW_END: '15:50',      // ET - never carry a position into a SECOND night; force out if the 09:35 exit was missed

  // --- Risk -------------------------------------------------------------------------------
  RISK_PCT_PER_TRADE: 0.15,      // same as overnight-drift; NOT the sweep's higher-scoring 25%
  MAX_CONCURRENT_POSITIONS: 5,   // all held the same night - see caveat 4
  PAUSE_DRAWDOWN_PCT: 0.30,
};
