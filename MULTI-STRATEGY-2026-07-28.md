# Multi-strategy expansion — 2026-07-28

Follow-up to the improvement research pass (IMPROVEMENTS-2026-07-28.md). User asked for
a wide strategy survey, a bot for every strategy that's "actually significant," a new
dashboard, and separate $1000 accounts per strategy.

## Research: 4 candidates tested, 2 survived

Real backtests against this account's own data/infra (scripts/strategy-*-sweep.js),
same evidentiary bar as the ORB-15 process:

| Candidate | Mechanism | Verdict |
|---|---|---|
| VWAP mean-reversion fade | Reversion, intraday | **Rejected** — negative/noise across every threshold and filter, full universe and index-only subset alike |
| Gap fill | Reversion, intraday | **Rejected** — best case +7.32bp unstable; adjacent gap-size bucket is -57.73bp |
| Overnight close-to-open drift | Continuation, swing/overnight | **Adopted** — long-only positive across every threshold tested (+7 to +16bp/trade), n=230-568 |
| 0DTE put credit spread | Premium selling, defined-risk | **Not deployed** — 72.4% win rate / +86bp of risk look real and match published research, but n=58 (SPY good, QQQ bad on tiny subsamples) is well short of this project's own 200-trade bar. User chose not to deploy this one now; would need a longer backtest (120-150 days) first if revisited. |

## Deployed: Overnight Drift bot

New, fully isolated strategy under `strategies/overnight-drift/` — own config, own
Alpaca client (own copy, not a shared import), own order/contract/risk modules, own
`.env.overnight` (new paper account, $1000, options level 3, gitignored). Zero shared
state or credentials with the ORB-15 bot.

- **Logic**: long-only. If a symbol's today (open→now) return is ≥ 1.0%, buy a call
  (or debit spread if the ATM single exceeds the $150 trade budget) near the close,
  hold overnight, sell at market shortly after tomorrow's open. The backtested short/put
  side on down days tested NEGATIVE and is deliberately not implemented.
- **Schedule**: not a continuous poll loop like ORB-15 (this strategy has exactly 2
  decision points/day) — two Windows scheduled tasks, `AlpacaOvernightDriftEnter`
  (weekdays 15:55 ET) and `AlpacaOvernightDriftExit` (weekdays 09:35 ET).
- **Risk**: more conservative than ORB-15 given real overnight gap exposure -
  `RISK_PCT_PER_TRADE=0.15` (vs ORB's 0.30), `MAX_CONCURRENT_POSITIONS=3`,
  `PAUSE_DRAWDOWN_PCT=0.30`, same manual-only guardrail-resume policy as ORB-15.
- **Real-world friction found during dry-run testing**: MSFT and COIN both had valid
  signals on first test but failed on affordability (spread debit $254/$154 exceeded the
  $150 budget) — the backtest measured pure underlying returns and didn't model this;
  expect a lower live fill rate on the pricier names than the backtest's full-universe
  numbers imply.
- Dry-run tested end-to-end against the real new account before going live (both
  `enter.js --dry-run` and `exit.js --dry-run`); confirmed long-only, budget/liquidity
  gates, and logging all work correctly.

## Dashboard

Per user's choice: same ngrok tunnel, new route — not a second deployed link.
`status-server.js` now also loads `strategies/overnight-drift/.env.overnight`
(`scripts/start-status-server.ps1` passes both `--env-file` flags; Node supports
multiple). New `GET /api/multi-status` aggregates every strategy into one array; new
`GET /multi` page (`multi.html`) renders one card per strategy, built to extend to a
3rd/4th strategy later without a rewrite. Existing `/` (ORB-15-only) dashboard is
untouched.

## Side effect: alpacaClient.js reliability fix

Heavy backtest usage across today's session (research + multi-strategy backtests) hit
Alpaca's data-API rate limit repeatedly. Added exponential-backoff retry for 429s to
`lib/alpacaClient.js` (own copy in `strategies/overnight-drift/alpacaClient.js` too) -
a reliability fix, not a strategy change, and it also protects the live ORB runner from
the same failure mode. (A concurrent session separately added retry handling for
network-level errors like ECONNRESET/ENOTFOUND to the same file the same day.)

## Uncommitted

Nothing committed to git this session, consistent with prior sessions - `git status
--short` for the full current diff.
