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

  // --- Ratcheting profit floor (lib/ratchet.js) ---
  // This bot already has uncapped upside (no profit target - winners ride to the flatten),
  // so the ratchet's job here is only the other half: once a trade has actually run, lock
  // the gains in. Every RATCHET_STEP_PCT of premium gain advances a rung and re-arms a
  // stop RATCHET_STOP_PCT below the last target reached.
  //
  // Levels are on combined premium, off entry debit.
  //
  // !! THE PARAGRAPH BELOW DESCRIBED THE 15/15 SETTINGS AND STOPPED BEING TRUE ON
  //    2026-08-04, WHEN THE STEP WAS CUT TO 0.02 AND THE TRAIL LEFT AT 0.15. It is kept
  //    verbatim because it is the stated design intent, and because a stale comment that
  //    contradicts the code is worse than no comment - see the correction after it.
  //
  //   > Step == stop distance is deliberate: it puts rung 1's stop exactly at breakeven,
  //   > so the first ratchet makes the trade free.
  //   >   rung 1   stop   0%   target +50%
  //   >   rung 2   stop +25%   target +75%
  //   >
  //   > The rung-0 stop is deliberately NOT used (minStopRung: 1 in runner.js). A trade
  //   > that never runs is still governed only by the existing, backtested or_mid_stop and
  //   > OPTION_STOP_PCT exits - this must not quietly introduce a tighter entry-side stop
  //   > than what was validated. The ratchet can only ever tighten a trade that is already
  //   > winning.
  //
  // CORRECTION (2026-08-30). With step 0.02 / trail 0.15, rung n's stop is n*0.02 - 0.15.
  // So rung 1 arms at +2% of premium and sets its stop at -13%, and the first rung whose
  // stop is not a loss is rung 8 (+16% gain, +1% stop). The ratchet therefore DOES now
  // introduce an entry-side stop tighter than what was validated, and it arms on a +2%
  // move - inside the quote noise of a contract MAX_SPREAD_PCT permits to be 8% wide. Live
  // evidence: 24 of 38 trail_stop exits are losses totalling -$660, armed at rungs 1-8,
  // with logged rung-1 advances firing at gains of 2.3-3.3%.
  //
  // That looked like a regression worth reverting, so it was MEASURED rather than assumed
  // (scripts/orb-ratchet-minstoprung.js, n=953 cached real-option trades, Jan-Aug 2026,
  // chronological out-of-sample half, at 0/4/8% round-trip cost). The result does not
  // support reverting, and contradicts the hypothesis:
  //
  //   out-of-sample, 4% cost    exp    maxDD  lossRate  avgLoss
  //     ratchet off            1519bp   1465%    66.5%    -33.7%
  //     minStopRung 0          1793bp    103%    43.4%    -13.2%
  //     minStopRung 1 (live)   1730bp    145%    40.3%    -17.2%
  //     minStopRung 8          1674bp    199%    34.0%    -26.1%   <- "restores" the intent
  //
  // Expectancy is FLAT across the whole minStopRung grid (0..16) at every cost level; the
  // only thing that changes is the shape of the losses - arming later gives fewer, bigger
  // ones and a WORSE drawdown. Restoring the literal contract above (minStopRung 8) would
  // make the bot worse, not better. The gradient mildly favours arming EARLIER, but rung 0
  // is the edge of the grid and the deltas are small, which is the exact boundary-optimum
  // signature this file already learned to distrust (see the 10/10 note below). So:
  // minStopRung stays at 1, and the comment is corrected instead of the code.
  // Tuned 2026-08-03 by scripts/orb-ratchet-sweep.js: 532 real-option trades over 120 days,
  // full 7x7 (step x trail) grid. The control row (ratchet off) reproduces this repo's own
  // options baseline - 2414bp/-32.8% avgLoss here vs the 2018.6bp/-32.3% that
  // sweep5-options.js recorded at OPTION_STOP_PCT 0.55 - so the sim is consistent with
  // prior work rather than a new methodology.
  //
  // The robust finding is not a single cell, it's the whole grid: ALL 49 combos cut max
  // drawdown from the control's 1238% to 110-271%, and loss rate from 63.0% to 16-55%,
  // with expectancy flat-to-better (2277-2860bp vs 2414). Capping the downside costs
  // nothing here, which is the entire point of the ratchet.
  //
  //   ratchet off (control)   exp 2414bp  maxDD 1238%  lossRate 63.0%  avgLoss -32.8%
  //   step 25 / trail 25      exp 2464bp  maxDD  162%  lossRate 48.5%  avgLoss -13.4%
  //   step 15 / trail 15      exp 2630bp  maxDD  126%  lossRate 38.3%  avgLoss -12.6%  <- set
  //   step 10 / trail 10      exp 2860bp  maxDD  110%  lossRate 30.6%  avgLoss -12.1%
  //
  // 10/10 scored best and is NOT used. Two reasons: it sits on the tightest edge of the
  // grid (a boundary optimum - the model just keeps rewarding tighter trails, which is a
  // modelling artifact, not an edge), and MAX_SPREAD_PCT below admits contracts with an
  // 8% bid-ask spread, so a 10% trail lives inside the quote noise band and would whipsaw
  // on spread rather than on price. 15% keeps the trail at ~2x the worst permitted spread
  // while still beating the previous 25/25 on every downside metric AND on expectancy.
  RATCHET_ENABLED: true,
  // 2026-08-04: step cut 0.15 -> 0.02 after scripts/orb-ratchet-research.js found a
  // LOOK-AHEAD BUG in the 2026-08-03 sweep that produced the 15/15 figures above. That
  // sweep advanced the rung on each bar's HIGH, which parks the stop just under the
  // intrabar peak and books exits at a price a 20s-polling bot cannot catch; the flaw got
  // stronger as settings tightened, which is why every grid "optimised" into its own
  // tightest cell. Re-run advancing on the bar CLOSE (n=1047, 8 months, 4% round-trip
  // cost), walk-forward tested on months the fit never saw:
  //     out-of-sample      avg/trade   worst drop   lose rate
  //     15/15 (old)          17.14%       -220%       44.1%
  //     2/15 (this)          17.65%       -145%       38.7%
  // Read 2/15 as "a 15% trailing stop that updates in 2% increments" - the 15% is what
  // keeps the trail clear of the up-to-8% spread MAX_SPREAD_PCT admits; the 2% step is
  // only the granularity it follows price with.
  RATCHET_STEP_PCT: 0.02, // premium gain per rung
  RATCHET_STOP_PCT: 0.15, // trail distance below the last target reached
  RATCHET_MAX_RUNGS: 100,

  // Contract selection
  MAX_SPREAD_PCT: 8, // skip entry if a leg's bid-ask spread exceeds this % of mid
  MIN_OPEN_INTEREST: 100,
  SPREAD_SHORT_STRIKE_OTM_PCT: 0.012, // debit-spread short leg target: ~1.2% OTM

  // --- Small-account rules (active whenever SMALL_ACCOUNT_MODE is true) ---
  // Aggressive by design: user goal is maximum growth of a $1000 account (paper).
  // 2026-08-04: cut 0.30 -> 0.15 (deliberate human decision; risk-caps.lock.json updated to
  // match, as that file's contract requires). Rationale from scripts/orb-sizing-study.js,
  // which replays the ratchet study's trades through real compounding at each size:
  //
  //   if the measured edge is real     30% grows ~2x faster than 15%. This is the cost.
  //   if the edge is slightly NEGATIVE 30% -> -98% account, 15% -> -89%, 5% -> -44%
  //
  // The edge is the least trustworthy number in that study: the option-bar backtest charges
  // nothing for the up-to-8% spread this bot will accept, assumes stops fill exactly at
  // their level, and has NO completed live trades to check against. A backtest claiming
  // ~19%/trade compounding would have produced an astronomical balance by now; the account
  // is at ~$2.8k. So the true edge is far below measured, which is precisely the regime
  // where oversizing stops being "faster growth" and becomes ruin.
  // Halving size gives up growth that may not exist, to survive an error that plainly does.
  // At 15% x 4 concurrent, peak exposure is ~60% of equity rather than ~120% - which also
  // ends the 'insufficient options buying power' order rejections logged on 2026-08-03.
  //
  // 2026-08-30: cut 0.15 -> 0.05 (deliberate human-authorised change; lock updated in the
  // same commit as this file, per the contract in scripts/guard-config.js). The 15% figure
  // above was sized against the options backtest's claimed edge. That claim is now
  // measurably false. Live, n=50 completed trades, return per trade against actual cost
  // basis (join EXIT to its ENTRY by symbol, cost = premium * 100 * qty):
  //
  //     live mean/trade   -3.62%   (sd 32.1%, SE 4.55%)
  //     backtest claim   +20.18%   (sweep5-options.js, OPTION_STOP_PCT 0.55)
  //     t, live vs backtest  -5.24  (p < 1e-6)
  //     t, live vs zero      -0.80  (NOT significant - see below)
  //
  // Read those two t-stats together, because they say different things. The edge being
  // NEGATIVE is not established; -0.80 is noise and 50 trades cannot resolve a 32%-sd
  // distribution. What IS established, overwhelmingly, is that the live process does not
  // deliver +20%/trade. Sizing is the one decision that must not be made on the optimistic
  // reading: the comment ten lines up already worked out that at a slightly-negative edge
  // 15% -> -89% and 5% -> -44%, and the account has since gone 2876 -> 2252 (-21.7% peak
  // to trough) with 1 of 50 trades (+$460 TSLA 08-19) carrying the entire profit, which is
  // exactly the fat-tailed shape BACKTEST-BASELINE.md warned 130-180 trades could not pin
  // down. 5% is the study's own next rung and keeps peak exposure near 20% of equity.
  //
  // 2026-09-06: REVERTED 0.05 -> 0.15 on Hudson's explicit instruction, to restore the
  // configuration that was in place at the 2026-08-21 equity peak ($2,876.18). Nothing in
  // the analysis above is retracted - it is still the case that the backtest justifying 15%
  // is rejected at t=-5.24, and that at a slightly-negative edge 15% -> -89% vs 5% -> -44%.
  // Recorded so the next reader knows this was a deliberate, informed choice and not drift.
  //
  // What is NOT restored, deliberately, because these were defects rather than settings:
  // the drawdown breaker now trails a high-water mark (at the peak it was anchored to a
  // stale $1000, putting the floor at $650 - it could not fire), exits book the actual fill
  // instead of the mid-mark, and entries require a CLOSED bar. So this is the peak's
  // aggression with a safety net that actually works, which the peak configuration did not
  // have. At 15%/trade the working breaker matters considerably more, not less.
  RISK_PCT_PER_TRADE: 0.15, // premium budget per trade = 15% of current equity
  MAX_CONCURRENT_POSITIONS: 4, // account-wide - raised from 2 on 2026-07-30 (deliberate human change, see risk-caps.lock.json). At 15%/trade this caps simultaneous commitment near 60% of equity.
  // 2026-08-30: cut 0.25 -> 0.10. At 25% the daily stop never fired once in the live
  // period - 2026-08-26 lost 16.4% of day-start equity and kept trading. A stop that has
  // never bound on the worst day it has seen is not a circuit breaker.
  // 2026-09-06: REVERTED to 0.25, the peak-day value, with the sizing revert above. The
  // 08-26 observation stands: at 0.25 this has still never bound on the worst day it has
  // seen, so treat it as a backstop against a catastrophic day, not as a daily risk control.
  DAILY_LOSS_STOP_PCT: 0.25, // stop entering after losing 25% of day-start equity
  // Floor trails a HIGH-WATER MARK, not initialCapital - see lib/riskManager.js. Anchored
  // to initialCapital it was structurally unable to fire: the file still held the $1000
  // reset baseline from 2026-08-03, putting the floor at $650 against $2252 of equity.
  PAUSE_DRAWDOWN_PCT: 0.35, // pause everything if equity falls 35% below its high-water mark

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
