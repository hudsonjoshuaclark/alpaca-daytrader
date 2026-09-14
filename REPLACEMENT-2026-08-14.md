# swing-signals retired, Overnight Momentum deployed — 2026-08-14

Instruction: *"if it isn't making money change it."* Applied per bot.

| Bot | Equity | Verdict | Action |
|---|---|---|---|
| ORB-15 | $2,651.78 | +165% live | Keep |
| Overnight Drift | $1,049.44 | +4.9% live | Keep |
| Credit Spread (0DTE) | $992.48 | Loss was entirely the sign bug fixed 08-13; strategy has never executed | **Probation** with fixed kill terms |
| Swing Signals (RSI) | $1,000.00 | 0 trades in 11 sessions; 18 trades/yr at +0.1bp | **Retired, replaced** |

---

## Credit Spread kept, not replaced — with terms

Its −$7.52 is the mleg sign bug, not the strategy: all three trades it ever placed closed on a
false `profit_target` within 0.4s of filling. Replacing it the day the blocker was removed
would discard n=247 / 71.7% evidence for no information. So it gets a defined trial instead of
an open-ended reprieve:

> **Review at 20 completed trades or 2026-09-15, whichever first.
> Retire if win rate < 55% or realized P&L is negative.**

Its three broken trades still produced real *fills*, which are worth something: round-trip
slippage was **9–15% of credit collected** (0.34→0.37, 0.17→0.19, 0.13→0.15). The backtest
models exits at bar close with zero bid/ask cost, so expect ~70bp of drag against the headline
+168bp. A result below +168bp is therefore not evidence of failure; a negative result is.

---

## Four searches before a replacement was accepted

Standards fixed **before** looking at any result: n ≥ 200, ≥ 100 trades/year, expectancy > 5bp,
positive in-sample **and** out-of-sample on a chronological 70/30 split, ≥ 50% of months
positive. Three of the four searches were rejected.

### Rejected — 6-mechanism screen
Gap-down reversal, gap-up continuation, relative strength vs SPY, dip-buy in an up market,
VWAP reclaim, power hour. Only **gap-up continuation** passed, at n=1663, +14.08bp, IS 14.0 /
OOS 14.1 — suspiciously perfect stability.

Validation killed it. That agreement existed at *exactly* gap ≥ 1.5% and nowhere else:

| gap threshold | IS | OOS |
|---|---|---|
| 1.5% | +14.0 | +14.1 |
| 2.0% | +5.1 | +15.7 |
| 2.5% | **−3.7** | +23.4 |
| 3.0% | **−3.0** | +28.7 |

The neighbouring thresholds show the same negative-IS / high-OOS divergence that killed
swing-signals — a regime artifact. The best of ~36 account configurations was **+4.0%/year**,
and most were negative. This was the ~1 false positive expected from scoring 12 combinations.

### Rejected — ORB-15's signal traded as shares
Plausible on paper: ORB-15's edge was originally validated *at the underlying level*, and it
is the only strategy here with a live record. But the edge does not survive the translation.

- Its own 12 names, long+short: +8.0bp, IS 8.3 / OOS 7.4 — stable, but that is the universe it
  was tuned on, i.e. confirmation of the existing bot, not a new one.
- The other 44 names: +3.2bp. Does not generalise.
- All 56, long only, after 5bp costs: **−0.5bp**. Account sim **−8.9% to −18.2%**, 4/13 months positive.

Conclusion: ORB-15 needs options leverage to be worth running. As shares it is noise.

### Rejected — retuning swing-signals itself
24-combo grid (documented 2026-08-13). Nothing deployable.

### Accepted — Overnight Momentum (shares)

Buy shares of names up ≥1.0% from today's open at 15:55 ET; sell at 09:35 ET next session.
Long only — the original overnight sweep tested the short side at −12.23bp and it was correctly
never implemented.

`scripts/strategy-overnight-shares-sweep.js`, 365 days, 46 symbols, 5bp assumed cost:
**n=3311, +15.7bp/trade, 50.8% win rate, IS +9.6 / OOS +29.7bp, 9/13 months positive.**
Compounded whole-share account sim at the deployed settings: **$1,000 → $1,375 (+37.5%),
max drawdown 5.6%, 849 trades.**

Why this cleared the bar when the others did not:

1. **Expectancy decays smoothly** across thresholds — 18.9 / 19.8 / 25.2 / 29.8 / 36.0bp at
   0.5 / 1.0 / 1.5 / 2.0 / 3.0%. Real effects decay; fitted ones spike.
2. **Positive IS and OOS at every threshold tested.** Not one negative in-sample cell.
3. **It generalises.** The 46 deployed names *exclude* the 12 the options overnight bot
   trades, and score better (+20.7bp) than that bot's own universe (+15.8bp). This is the exact
   test ORB-shares failed.
4. **All 12 account configurations were positive** (+14.8% to +53.4%).
5. It independently reproduces this project's own 2026-07-28 finding (+7 to +16bp/trade on the
   underlying) on a wider, non-overlapping universe.

**Parameters chosen to be least-fitted, not best-scoring.** Threshold 1.0% and risk 15% both
match the already-validated overnight-drift bot rather than the sweep's optimum. The sweep's
best cell was risk 25% / max 5 at **+84.6%** — deliberately not taken, being the single most
overfit cell and a doubling of gap-tail exposure.

---

## What is honestly wrong with the thing I just deployed

1. **Most of it is not alpha.** Holding these names overnight *unconditionally* earned
   +12.6bp over the same sample. The up-1% filter adds only **+7.2bp** on top. The bulk of the
   return is the well-documented overnight risk premium.
2. **It is long beta.** The sample (2025-08 → 2026-08) had SPY +21.0%, of which +18.8% accrued
   overnight. In a falling market this loses money. It has never been tested through a bear market.
3. **Real gap tail.** Worst single trade −27.1%, 1st percentile −6.5%. The position is held
   while the market is closed, so it cannot be stopped out. At 15% sizing a −27% gap costs ~4%
   of the account.
4. **Correlated same-night exposure.** Up to 5 positions are held on the same night; a
   market-wide gap down hits all of them. The 5.6% simulated drawdown reflects this.
5. **Only 25 of the 46 names fit the $150 per-trade budget at $1,000 equity.** The backtest
   models this identically (whole-share flooring), and the effective universe widens as equity
   compounds — but on any given night the bot may deploy well under full capital.
6. Survivorship bias: today's watchlist applied to a year of history. Shared by every backtest
   in this project.

---

## Two bugs found by testing the new bot before trusting it

- **Silent bar truncation.** Alpaca caps a multi-symbol bars response at `limit` rows *total*
  and fills them symbol-by-symbol, so an over-limit request returns complete data for the first
  few symbols and **nothing** for the rest, with no error. The test asked for 5 days × 46
  symbols and got data for **8 names**. Both the runner and the test now follow
  `next_page_token`. After the fix: 46/46 symbols, 22 qualifying vs 8 before.
- **Implementation drifting from the backtest.** The first `tryEnter` fell through to cheaper
  names when a top-ranked one exceeded the budget. The backtest ranks, slices to the cap, *then*
  drops unaffordable names without substituting. Falling through would have systematically
  shifted the traded universe toward low-priced stocks — a silent live/backtest divergence.
  The runner now matches the backtest exactly and logs `UNAFFORDABLE` when a slot goes unused.

---

## Cutover

- swing-signals runner stopped; `AlpacaSwingSignalsRunner` **disabled** (not deleted — reversible).
  Its `config.js` carries a RETIRED banner; code and logs kept for history.
- `strategies/overnight-momentum/` created on the **same account** (PA3AA9K57G7R, $1,000).
  State is persistent (`state.json`), not daily-reset — the structural change required to hold
  overnight.
- Continuous runner, not two scheduled scripts. Deliberate: overnight-drift's twice-daily
  scheduled-task design is exactly what silently lost both runs on 08-11 and 08-12.
  A polling process writes the heartbeat the dashboard already watches.
- New task `AlpacaOvernightMomentumRunner` (weekdays 09:15 ET, WakeToRun, StartWhenAvailable).
- Dashboard card, `scripts/restart-strategy-runner.ps1`, and `scripts/start-status-server.ps1`
  all updated.

**Safety net added:** a position must never see a second night. If the 09:35 exit is missed
(machine asleep, broker outage), the runner force-exits before that session's close rather than
silently doubling the holding period the backtest measured.

## Verification

- `strategies/overnight-momentum/test.js` — **28/28 pass**, including config sanity, persistent
  state, entry gates, sizing, live signal evaluation against real bars, and account isolation.
- `scripts/test-fixes-2026-08-13.js` — 42/42 still pass.
- `node --check` clean on every modified file.
- All four runners live: one instance each, zero stderr, fresh heartbeats.

**Note:** `status-server.js` was briefly corrupted by a PowerShell text round-trip (em dashes
and ⚠ mangled, BOM added) and was repaired byte-precisely; a full non-ASCII scan of the file
now shows only correct U+2014 / U+2013 / U+26A0.

## Open

- First real trade lands at 15:55 ET today. Expect the exit at 09:35 ET the next session.
- Caveat 2 is the one to watch: this is a long-beta strategy. If the market turns, it loses.
- Not tested and deliberately left alone: whether falling through to affordable names beats
  matching the backtest. It would deploy more capital but is unvalidated.
- Nothing committed to git — no commit was requested.
