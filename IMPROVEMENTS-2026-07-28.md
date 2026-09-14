# Improvement pass — 2026-07-28

Follow-up to a wide research survey ("ways to improve an AI trading bot" — strategy, risk,
execution, data, backtesting rigor). This document is what actually got tested against
this bot's real history and what happened as a result. Same evidentiary bar as
AGENT-REVIEW.md throughout: infra/execution fixes ship without a backtest, strategy
changes need real evidence, and "no change, here's why" is a legitimate outcome.

## Shipped without a backtest (execution/infra, no strategy risk)

- **Fill-vs-quoted-mid logging** (`runner.js`, `ENTRY` event): `quoteMidAtOrder` captured
  at order time, `fillVsMid`/`fillVsMidPct` computed against the actual fill price.
  `MAX_SPREAD_PCT` already gates on quoted spread at decision time; this measures what
  the fill itself cost, which the quote alone can't capture (queue position, price
  movement between quote and fill).
- **Fill-quality dashboard tile** (`status-server.js`/`status.html`): rolling
  last-20-fill and all-time average, reads the field above.

## Tested and REJECTED

- **VWAP alignment on the breakout bar**: excludes 1 of 412 signals. No discriminative
  power for this strategy — an ORB breakout is already almost always on the correct
  side of VWAP by construction. Not applied.
- **Excluding CPI/NFP/FOMC days**: cuts expectancy from 11.80bp to 2.95bp; those days
  ALONE are 66.93bp. This strategy's documented edge is fat-tailed and driven by rare
  large-move days (BACKTEST-BASELINE.md / sweep5-options.js) — macro-print days are
  disproportionately those days. Blacking them out would have been actively harmful,
  the same shape of mistake as the daily "hot name" screener that was tried and
  rejected in the original strategy build. `lib/macroCalendar.js` (real 2026 FOMC/
  CPI/NFP dates) exists as pure data for future reference but is deliberately NOT
  wired into any entry gate.
- **Volatility-regime gate** (trailing-10-day SPY range% tercile): inconclusive
  (low=19.24bp > mid=11.22bp > high=8.87bp). Differences are small relative to sample
  size, the measure is a lagging proxy, and it's in tension with the macro-day finding
  above (real vol spikes are exactly what the edge depends on). Not applied.
- **Half-open auto-recovery for the drawdown pause** (a circuit-breaker pattern from
  the original research): rejected on inspection, not on evidence. `lib/riskManager.js`
  and AGENT-REVIEW.md rule 5 both deliberately require a human to clear
  `pausedForReview` — auto-resume would undo a considered safety decision, not fix a
  bug. Circuit-breaker half-open logic is right for transient technical failures
  (the watchdog already does this for the runner process); it's wrong for a
  capital-preservation stop meant to force a human to look.
- **Walk-forward on RVOL_MIN / entry cutoff** (180 days, 30-day rolling windows,
  `scripts/walkforward.js`): this ended up confirming the current values rather than
  finding better ones. The in-sample "best" combo changes almost every window (an
  overfitting signature — see the script output), while the live config's expectancy
  sign holds 4-of-6 positive windows, consistent with the already-documented "positive
  3 of 4 months" pattern. No parameter change supported.

## Tested and ADOPTED

- **Relative-strength-vs-SPY entry filter** — live in `runner.js` /
  `lib/marketData.js`. Full numbers in BACKTEST-BASELINE.md. Summary: cross-validated
  at both the underlying level (16.38bp → 18.89bp, n=307 kept) and the real-option
  level (3044.58bp → 3315.29bp, n=270 kept) — the same ~16 excluded trades are negative
  in both views, which is a much stronger signal than either view alone. Runner and
  status dashboard restarted 2026-07-28 01:04 ET (market closed) to pick this up;
  confirmed single instance, clean heartbeat, no startup errors.

## Risk finding, no code change

- **Monte Carlo reshuffle/bootstrap** on the 90-day real-option trade list
  (`scripts/montecarlo.js`), scaled to actual `RISK_PCT_PER_TRADE` (0.30) rather than
  100%-per-trade compounding: median resampled max drawdown **-89%**, 5th percentile
  **-98%**. This isn't a strategy problem — it's what a ~40% win rate with a bounded
  ~55% max loss per trade genuinely implies about sequencing risk at this position
  size, and it's the concrete, quantified reason `PAUSE_DRAWDOWN_PCT` exists. No sizing
  change was made — `RISK_PCT_PER_TRADE` is a locked cap (guard-config.js) and
  deliberately out of scope for a filter-validation pass; changing it is a Tier-C,
  human-decision item, not something a backtest alone should settle.

## New reusable tooling

- `scripts/montecarlo.js` — trade-return reshuffle/bootstrap, works on any sweep
  script's raw return list, position-size-scaled.
- `scripts/walkforward.js` — rolling in-sample-optimize / out-of-sample-validate
  harness for the ORB param grid.
- `scripts/sweep6-filters.js` — fast underlying-only harness for testing new entry
  filters against the live 12-symbol universe.
- `scripts/sweep7-relstrength-options.js` — same pattern as sweep5-options.js's real
  historical-option-contract resolution, applied to a specific filter hypothesis.
- `lib/macroCalendar.js` — 2026 FOMC/CPI/NFP dates, pure data, not wired into anything.

## Explicitly NOT done (Tier C — bigger than one pass, needs a deliberate decision)

- A second, genuinely uncorrelated strategy.
- Extending debit spreads to the full universe (needs real two-leg spread pricing data,
  bigger build than this pass).
- Quality-scaled position sizing within the risk cap (plausible, untested — would need
  its own dedicated backtest weighting historical trades by a proposed sizing rule).
- Revisiting `SMALL_ACCOUNT_MODE`'s caps now that the PDT rule is gone (June 2026) —
  worth a deliberate look, not a default change.
- A paid options-flow data upgrade to the trader-advisory agent.
- ML/RL signal generation — explicitly not a roadmap item; see the original research
  memo for why.

## Uncommitted

Per session policy, nothing was committed to git — all of the above (plus the
pre-existing 2026-07-24 manual-close-button work in status-server.js/status.html) sits
uncommitted in the working tree. `git status --short` for the current full list.
