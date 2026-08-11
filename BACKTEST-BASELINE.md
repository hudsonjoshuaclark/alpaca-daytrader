# Backtest baseline — ORB-15 strategy (established 2026-07-16)

Reference numbers the live bot is expected to track. Derived from scripts/sweep2.js and
scripts/sweep3.js over 90 calendar days (~61 sessions) of 5-min IEX bars on the 12-name
liquid universe. All figures are on the UNDERLYING move (options add leverage, spread
cost, and theta on top).

| Metric | Backtest value |
|---|---|
| Expectancy per trade (underlying) | +8.1 bp |
| Win rate | 43.6% |
| Avg winner | +1.20% |
| Avg loser | -0.79% |
| Trades per day (12 symbols, pooled) | ~10 signals/day pooled; live bot takes max 2 concurrent, one per symbol/day |
| Monthly consistency | positive 3 of 4 months (May 2026 was -10.5bp — losing months HAPPEN) |
| Best entry window | 09:45–11:00 (+14.3bp); decays after |

Failed alternatives (do NOT re-adopt without new evidence):
- EMA9/21 crossover + VWAP + RVOL (original strategy): negative in every configuration
  tested (-0.3 to -3.6bp across 30 combos, sweep.js)
- Fading the EMA crossover: ~0 to negative after realistic brackets (sweep2.js)
- Daily "hot name" screener gating of ORB entries: made it WORSE (-21.6bp vs +1.1bp
  ungated on the affordable cohort, sweep4.js) — yesterday's heat selects next-day chop
- Cheap/meme-stock cohort (SOFI, MARA, RIOT, MU, INTC): pooled ~0bp, unstable

Live-vs-backtest divergence is EXPECTED from: option spread costs (entry limit at
mid+¼ spread saves most but not all), theta on held winners, 20s polling granularity
on stops, and unfilled entry limit orders (missed trades).

## Options-level validation (added 2026-07-21, scripts/sweep5-options.js)

After the live bot went 4-for-4 losses (all via `option_stop`) since 7/17, investigated
whether `OPTION_STOP_PCT` (0.55) — which, per the section above, was NEVER included in
any sweep script's simulation, only the underlying was ever backtested — was silently
cutting trades short before the validated orMid/EOD exit ever got a chance to apply.

Built `scripts/sweep5-options.js`: replays the exact same ORB signals sweep3.js finds
(same universe, same orMid stop, same EOD flatten) but against REAL historical option
premium bars (`/v1beta1/options/bars`, confirmed available 90+ days back on this
account) instead of the underlying's own price, via a self-calibrating ATM-contract
resolver (tries plausible strike increments per price tier, keeps whichever constructed
OCC symbol actually has real historical data closest to the entry price).

**Two bugs were found and fixed in the test script itself (not in the live bot) before
trusting any output:**
1. Option-premium stop check was direction-conditional (`isBull ? bar.l : bar.h`),
   copied from the underlying-price stop pattern. Wrong — we're always LONG the option
   (calls on bullish signals, puts on bearish), so a loss always means premium went
   DOWN regardless of signal direction. Fixed to always check `bar.l`.
2. `entryPremium` was anchored to the option's first bar of the day (market open,
   09:30) instead of the actual signal/breakout time (typically 20-90+ min later).
   Fixed to find the option bar at/after the stock signal's actual entry time.

**Results, 45-day window, n=132-134 resolved real-option trades:**

| OPTION_STOP_PCT | winRate | expectancy | avgWin | avgLoss | exit reasons (stop/orMid/eod) |
|---|---|---|---|---|---|
| 0.55 (current) | 40.2% | +2018.6bp | +98.5% | -32.3% | 25/44/63 |
| 0.70 | 35.1-40.2% | +1826-1960bp | +98.5-115.6% | -33.3 to -34.3% | 14/51/67 |
| 0.85 | 40.2% | +1895.8bp | +98.5% | -34.4% | 9/55/68 |
| none | 40.2% | +1884.9bp | +98.5% | -34.6% | 0/56/76 |

**Key findings:**
- `option_stop` is NOT the dominant loss driver across this sample — `or_mid_stop`
  fires 3-4x more often than `option_stop` even at the current 0.55 threshold, and
  win rate barely moves as the threshold is loosened or removed entirely. This
  contradicts the initial hypothesis that the premium stop was silently overriding
  the validated exit rule.
- The large positive expectancy is driven by a small number of REAL extreme days
  (verified against raw bars — genuine high-volume, high-trade-count moves, not bad
  ticks) where a correctly-directioned ORB signal caught a large real move, producing
  triple-digit % option gains on that single trade. Example: SPY 2026-06-09 put,
  +1196% (a real, high-volume crash-type move that day).
- **This means the options-level return distribution is fat-tailed/leverage-amplified
  in a way the underlying never was**: an 8-day test window on the same logic showed
  strongly NEGATIVE expectancy; the 45-day window is strongly positive, entirely
  because it happened to include a couple of extreme days. Sample-to-sample variance
  at the options level is much higher than at the underlying level — 130-180 trades
  is not yet enough to pin down a stable number the way ~600 underlying-only trades
  was in the original sweep.
- **Implication for the live 4-loss streak**: this is consistent with an unlucky run
  of ordinary days for a strategy whose edge depends on rarer, larger winning days —
  not evidence the strategy or `OPTION_STOP_PCT` specifically is broken. No config
  change is supported by this evidence; the honest conclusion is "not enough signal
  yet to distinguish bad luck from a real problem," same as the underlying-only
  30-trade threshold in AGENT-REVIEW.md, likely more trades needed at the options
  level given the higher variance.

## Relative-strength-vs-SPY entry filter (added 2026-07-28, live in runner.js)

Part of a wider improvement pass (see IMPROVEMENTS-2026-07-28.md for the full research
list, what else was tested and rejected, and what was deliberately left untouched).
`lib/marketData.js`'s `computeRelativeStrength()`: at the breakout bar, require the
symbol to be outperforming SPY (bullish) or underperforming it (bearish) since today's
open. SPY/QQQ exempt (they ARE the benchmark). Blocks via a new `RELSTRENGTH_BLOCKED`
event, consumes the day's one ORB attempt for that symbol, same as `NEWS_BLOCKED`.

**90-day validation, cutoff=11:30 (matches live `cfg.ORB_ENTRY_CUTOFF`):**

| Level | Pool | n | expectancy |
|---|---|---|---|
| Underlying | unfiltered (apples-to-apples, non-SPY/QQQ) | 324 | +16.38bp |
| Underlying | filtered (in-favor kept) | 307 | +18.89bp |
| Underlying | excluded (against) | 17 | -28.96bp |
| Options (real contracts) | unfiltered (apples-to-apples, non-SPY/QQQ) | 286 | +3044.58bp |
| Options (real contracts) | filtered (in-favor kept) | 270 | +3315.29bp |
| Options (real contracts) | excluded (against) | 16 | -1523.74bp |

Same ~16 trades are negative at both levels — cross-validated, not overlapping noise.
Monthly breakdown (scripts/sweep6-filters.js) shows a small, consistent per-month
improvement, not one lucky month driving the aggregate. Two filters tested alongside
this and REJECTED: VWAP-alignment on the breakout bar (excludes 1/412 signals — no
discriminative power) and excluding CPI/NFP/FOMC days (cuts expectancy from 11.80bp to
2.95bp; those days alone are 66.93bp — confirms the fat-tail edge above lives
disproportionately on macro-print days, so blacking them out would have been actively
harmful). Volatility-regime bucketing (trailing-10d SPY range% tercile) was
inconclusive (low=19.24bp > mid=11.22bp > high=8.87bp, differences small relative to
sample size) and not applied.

Walk-forward validation (scripts/walkforward.js, 180 days / 30-day rolling windows)
separately confirmed the EXISTING `RVOL_MIN=1.5` / cutoff=11:30 rather than suggesting a
change: the in-sample "best" param combo changes almost every window (an overfitting
signature), while the live config's expectancy sign holds 4-of-6 positive windows,
matching the already-documented "positive 3 of 4 months" pattern.

Monte Carlo reshuffle/bootstrap (scripts/montecarlo.js) on the 90-day real-option trade
list, scaled to actual position sizing (`RISK_PCT_PER_TRADE`=0.30, NOT 100%-per-trade
compounding): median resampled max drawdown -89%, 5th percentile -98%. This is a real
tail-risk finding at current sizing, not evidence against the filter above — it's the
reason `PAUSE_DRAWDOWN_PCT` exists, and the Monte Carlo shows that threshold is
realistically reachable from bad luck alone. No sizing change was made (RISK_PCT_PER_TRADE
is a locked risk cap per guard-config.js and out of scope for a filter-validation pass).
