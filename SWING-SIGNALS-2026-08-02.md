# Swing-signals bot — 4th isolated strategy — 2026-08-02

User asked for a 4th bot, separate from the other 3, trading on rule-based technical
**signals** with **swing**-style multi-bar holds, **several trades/day**, and real
**stop-loss + automatic take-profit ("cutoff") discipline** on every trade. Also asked
whether a free platform with direct API/MCP access to Claude existed for trading actual
stock shares (vs. options, which the other 3 bots trade) - research confirmed Alpaca
already is that platform (it's what the other 3 bots already run on, has an official MCP
server too), so this bot trades **direct stock shares** via Alpaca's plain order endpoint
rather than options - simpler than every other bot here, no contract selection needed.

## Signal research (scripts/strategy-swing-sweep.js)

Backtested 3 long-only candidate signals against the existing `lib/watchlist.js` universe
(56 liquid names), stop/target grid-searched, same evidentiary bar as every other bot
(~200 trades minimum):

- **MACD signal-line cross + EMA(50) trend filter** - REJECTED. n=20,716 (huge sample),
  but expectancy is ~0-1bp across nearly the whole grid and goes negative at wider
  stops; 5 of 12 months net negative. No real edge.
- **EMA(9/21) cross + volume filter** - not deployed. Real but thin edge (~1-4bp/trade),
  inconsistent month to month. (Note: a *different* EMA9/21 cross was already rejected
  for ORB-15's own 1-min/options setup - this tested the same family idea on a swing
  timeframe with a volume filter, so it wasn't a blind repeat, but it landed weak again.)
- **RSI(14) pullback in an uptrend** - ADOPTED. Price above EMA(50) + RSI crosses back up
  through 30. n=324 over 365 real days (clears the 200-trade bar), and unlike the other
  two, positive expectancy across **every single stop/target combination tested**
  (verified with a widened grid up to 6%/12% specifically to rule out an edge-of-grid
  artifact) - a real robustness signal, not a lucky corner.

## The stop/target tradeoff, decided explicitly with the user

Within the RSI signal, two very different-looking backtest results turned out to be the
same signal measured two ways:

- **Wide (5% stop / 12% target)**: highest raw expectancy (46.48bp/trade), 9/12 months
  positive. But instrumenting exit reasons showed **95% of trades (307/324) never
  touched either threshold** - they just rode to the forced 15:45 ET flatten. The
  stop/target here are dormant tail-risk backstops; this is really "buy the RSI dip,
  hold to close," not stop/target-disciplined trading.
- **Balanced (1.5% stop / 2.0% target) - DEPLOYED**: stop and target genuinely drive
  most exits (113 stops / 105 targets / 106 EOD - close to an even three-way split).
  Lower expectancy (20.24bp/trade) but real: +65.58% summed return over the sample,
  51.9% win rate, 7/12 months positive. Chosen over the higher-expectancy wide option
  specifically because it matches what was actually asked for (active stop-loss/
  take-profit discipline), not because it backtested better. March 2026 was a real
  losing month (-32.51bp) - also seen across nearly every other candidate/bot tested
  that month, so it reads as a market-wide event, not a flaw specific to this signal.

**Honest caveat on trade frequency**: the validated signal fires ~324 trades / ~252
trading days ≈ 1.3 entries/day *averaged across the entire 56-symbol watchlist* - not
consistently "several" trades every single day, it clusters (some days 0, some days
3-4). User chose to deploy as-is rather than loosen the signal (and risk diluting the
just-proven edge) or expand the watchlist first.

## What was built: strategies/swing-signals/

Fully isolated, same pattern as `strategies/credit-spread/` - own `config.js`,
`alpacaClient.js`, `orders.js`, `riskManager.js`, `indicators.js` (own copy of
`ema`/`rsi`, not importing shared `lib/`), `watchlist.js` (own copy, pinned to exactly
the universe the backtest validated), `.env.swing`.

- **Mechanism**: `runner.js` polls every 60s (5-min bars only update every 5 min, no
  need to poll faster for signal scanning; stop/target checks against live position
  data are cheap and still happen every tick). Scans the watchlist for the RSI signal
  during a `09:45`-`15:30` ET entry window, manages every open position's stop-loss/
  take-profit off Alpaca's live `unrealized_plpc` (no bars needed for exits), force-
  flattens at `15:45` ET - same day-trading discipline as every other bot here.
- **Sizing**: `RISK_PCT_PER_TRADE=0.12` (smaller than the single-position bots since
  this one can hold several positions across different symbols at once - total exposure
  is what matters), `MAX_CONCURRENT_POSITIONS=5`.
- **New pattern introduced**: `MAX_TRADES_PER_DAY=8` - no bot in this project had a
  same-day entry-count cap before; added since this bot's signal can in principle fire
  on multiple watchlist symbols in one session. Also added `DAILY_LOSS_STOP_PCT=0.20`
  (a same-day circuit breaker, previously only on root ORB-15) since this bot trades
  multiple times/day, so a bad day can compound faster than the single-shot bots.
- **Risk**: `PAUSE_DRAWDOWN_PCT=0.30`, same manual-resume-only guardrail policy as
  every other bot.

## Dashboard

Added `buildSwingSignalsStatus()` to `status-server.js`, pushed into `/api/multi-status`
as a 4th card ("Swing Signals (RSI)") - confirmed `multi.html`'s card renderer is fully
generic (same as when credit-spread replaced trader-mimicry), so no HTML structure
changes were needed, just added `SIGNAL_ENTRY` to the event-label map and generalized
`NO_STRUCTURE`'s label from "no affordable contract" to "no viable trade" since this bot
has no options contracts. `scripts/start-status-server.ps1` updated with a 4th
`--env-file` flag so the dashboard can read this bot's account too.

## Status: blocked on the 4th account

Alpaca account creation is dashboard-only (no API) and this project's own history shows
real, if indirect, evidence of a ~3-simultaneous-paper-account-per-login cap (the last
time a 4th strategy was needed, credit-spread reused trader-mimicry's account rather
than provisioning a new one). User is attempting to create a genuinely new 4th paper
account; `.env.swing` currently holds placeholder credentials so the code can be
syntax/require-checked, but the runner cannot go live (or even dry-run test, since
`orders.getAccount()` is called unconditionally every tick regardless of `--dry-run` -
same pattern as every other bot's runner) until real API keys are in place. Remaining
steps once keys arrive: dry-run test, register the `AlpacaSwingSignalsRunner` scheduled
task (continuous-runner pattern, mirrors `AlpacaCreditSpreadRunner`), start the runner,
confirm single instance + clean heartbeat + correct dashboard card.

## Uncommitted

Nothing committed to git this session, consistent with every other change in this
project's history.
