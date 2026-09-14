# Trader-mimicry bot — 2026-07-28

User asked the trader-advisory agent to "watch the best, most profitable traders live and
make moves based on what they are doing" - this reverses two prior decisions (2026-07-20:
no LLM in the live trading loop; the advisory agent's own "advisory-only, off the live
path" choice). Flagged both explicitly; user confirmed twice they want this reversed.

## Reality check on the data source

There is still no legitimate feed of real professional traders' live trades - that
constraint hasn't changed since the advisory agent was built. Researched two proxies:

- **SEC Form 4 insider trading**: real, free, no API key, verified live against SEC's own
  EDGAR feed. Filed within 2 business days by law - genuinely fast. This is solid and is
  what got built.
- **Congressional trading**: the free options are dead. Both major free trackers (House
  Stock Watcher, Senate Stock Watcher) are defunct - confirmed `senatestockwatcher.com`
  doesn't even resolve anymore, its GitHub data source hasn't been touched since March
  2021. Every currently-working option (Quiver, EODHD, FMP, Apify) requires payment. Also,
  congressional trades are legally disclosed 30-45 days late regardless of source - never
  actually "live." Not built; user can revisit with a paid API if wanted.

## What was built: strategies/trader-mimicry/

Fully isolated, same pattern as overnight-drift: own config/client/orders/contracts/
riskManager, own `.env.mimicry` (new $1000 paper account, options level 3), zero shared
credentials or state with the other two bots.

**No backtest exists for this strategy** - unlike ORB-15 and overnight-drift, "what would
an LLM have decided given historical insider filings and sentiment" isn't something this
project's sweep-script harness can evaluate. Every risk parameter is a conservative
judgment call, tighter than both other bots on every axis:

| Param | ORB-15 | Overnight Drift | Trader Mimicry |
|---|---|---|---|
| Risk/trade | 30% | 15% | **10%** |
| Max concurrent | 2 | 3 | **2** |
| Drawdown pause | 35% | 30% | **20%** |
| Max new entries/day | n/a (per-symbol) | n/a (per-symbol) | **1 (hard cap, total)** |

## Safety design: propose vs. execute

The core design choice: an LLM agent NEVER has order-placing tool access.

1. `propose.js` gathers real SEC Form 4 insider open-market buys (filtered to genuine
   `transactionCode='P'` purchases, excluding routine RSU grants/option exercises) plus
   StockTwits sentiment for each candidate.
2. A Sonnet agent (`AGENT-TRADER-MIMICRY.md`, run via `propose.ps1`) reviews the signals,
   researches context with WebSearch, and writes AT MOST one proposal to
   `logs/proposal.json`. Its `allowedTools` is Read/Glob/Grep/Write/WebSearch/WebFetch
   only - no Edit, no Bash, no git. It cannot place a trade even if it wanted to.
3. `execute.js` - plain code, zero LLM - reads that proposal, enforces every cap above,
   and is the only thing that ever calls the order-placing API.
4. `exit.js` - checks daily for profit-target (+50%)/stop (-35%)/holding-period (5 trading
   days) exit conditions.

**Real-world validation, same day**: ran the full pipeline for real. The agent correctly
identified the only candidate on the day's list (a $2.6M insider buy in a microcap, STFS)
as a probable pump-and-dump - inconsistent role-attribution data, one-sided "short
squeeze"-flavored StockTwits chatter, a history of trading halts, no credible catalyst -
and declined to propose a trade rather than force a marginal case. `execute.js` correctly
did nothing as a result. Also tested with a synthetic AAPL proposal in `--dry-run`: the
full gate → contract-selection → budget chain ran correctly and correctly rejected it
(spread cost $272 > the $100 budget) - the same real-world affordability friction already
seen in overnight-drift, worth expecting here too.

## Scheduling

Three Windows scheduled tasks, weekdays: `AlpacaTraderMimicryPropose` (08:30 ET, before
open), `AlpacaTraderMimicryExecute` (09:40 ET, after open), `AlpacaTraderMimicryExit`
(15:50 ET, before close).

## Dashboard

Added as a third card on the existing `/multi` page (`status-server.js` now loads a third
`--env-file`). Shows today's proposal/reasoning explicitly (not just whether a trade
happened) and prominently notes the no-backtest caveat on the card itself.

## Uncommitted

Nothing committed to git this session, consistent with prior sessions.
