# Credit-spread bot replaces Trader Mimicry — 2026-07-31

User's ORB-15 frustration ("I keep losing, it never knows when to get out") turned out
to be the strategy's known low win rate (37-40%) working as designed — checked the real
exit data and every stop fired right at its expected level, nothing was broken. But the
user reasonably wanted a bot with a fundamentally different, higher-win-rate payoff
shape rather than ORB-15's rare-big-winners structure. Explicitly flagged the tradeoff
before building: high win rate usually means small frequent wins + occasional large
losses, not "safer" - just a different risk shape.

## Evidence, extended to a real sample size

The 0DTE put credit spread candidate from the earlier multi-strategy research (n=58,
72.4% win rate) was too thin to trust. Re-ran over 180 days: **n=247, 71.7% win rate,
+168.01bp expectancy**, consistent between SPY (71.0%/n=124) and QQQ (72.4%/n=123), 5 of
6 months positive (beats ORB-15's own "3 of 4" validation bar) - clears this project's
200-trade bar with room to spare.

**Explicitly flagged before deploying**: the most recent month tested (July 2026) was a
real LOSING month (-159.29bp), and 3 of the 5 worst individual trades were from that same
month. High win rate does not mean no drawdowns - it means long win streaks punctuated by
real losses, the same trap in reverse that just burned the user on ORB-15. User chose to
deploy anyway with this understood.

## What was built: strategies/credit-spread/

Replaces `strategies/trader-mimicry/` on the SAME account (that bot had zero backtest
evidence and traded rarely - retired its 3 scheduled tasks, reused its $1000 account and
API keys under new isolated env var names in `.env.creditspread`).

- **Mechanism**: sells 0DTE put credit spreads on SPY/QQQ only (the two names that
  reliably have same-day expiration options) - short put ~1% OTM, $3-wide protective
  long put, both same expiration. Parameters match the validated backtest exactly:
  `SHORT_OTM_PCT=0.01`, `WIDTH=3`, `PROFIT_TARGET_PCT=0.50` (close at 50% of max
  credit), `STOP_MULTIPLE=2.0` (close if spread value doubles against the position).
- **Architecture**: unlike overnight-drift/trader-mimicry's twice-daily scripts, this
  needs a CONTINUOUS runner (like ORB-15) - profit-target/stop conditions on a same-day-
  expiring spread can hit at any point during the day, not just at two fixed checkpoints.
  `strategies/credit-spread/runner.js` polls every 20s: enters during a
  09:35-10:00 ET window, monitors continuously, force-closes at 15:45 ET (0DTE
  assignment risk if held into the close).
- **Sizing**: fixed 1 contract per spread per symbol, not budget-based - at $3 width,
  max risk per contract is typically $200-280 (20-28% of this $1000 account already for
  ONE contract), so percentage-of-equity budgeting rounds to zero contracts. A live
  safety check skips entry if the day's actual max risk would exceed 30% of equity.
- **Risk**: `PAUSE_DRAWDOWN_PCT=0.25`, `MAX_CONCURRENT_POSITIONS=2` (naturally capped -
  only 2 symbols traded), same manual-resume-only guardrail policy as the other bots.

## Bug found and fixed during testing

`getLatestUnderlyingPrice` (bars fetch with `limit:1` and no `start` param) returned a
stale pre-market bar instead of the actual latest price when tested live at 15:50 ET -
confirmed by comparing against an explicit `start`-windowed query. Fixed by adding an
explicit recent `start` time and taking the last bar. The exact same bug pattern exists
in the now-retired `strategies/trader-mimicry/execute.js` - left alone since that bot's
scheduled tasks are gone and the file is unused, but worth knowing if it's ever revived.

## Scheduling

`AlpacaCreditSpreadRunner` - weekly trigger, weekdays 09:15 ET, `WakeToRun` +
`StartWhenAvailable` enabled. Could not add a redundant AtLogOn trigger (same
"Access is denied" elevation requirement seen before with the ngrok tunnel task) -
this session's permission level doesn't allow it. Runner started live and confirmed
healthy (clean START/DAY_END cycle, fresh heartbeat, zero errors) same day.

## Dashboard

Replaces the "Trader Mimicry" card on `/multi` with "Credit Spread (0DTE)" - same
generic card renderer, no HTML changes needed. Strategy note on the card explicitly
states the backtest numbers AND the July losing-month caveat, not just the good news.

## Uncommitted

Nothing committed to git this session, consistent with every other change this session.
