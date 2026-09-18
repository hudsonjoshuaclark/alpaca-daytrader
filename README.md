# Alpaca Day Trader

A set of automated trading bots I run on Alpaca paper accounts, one $1,000 account per
strategy. Plain Node.js, no dependencies, no framework.

The interesting part of this repo is not the trading. It is the rule I hold every
strategy to: **a strategy ships only if a backtest says it works, and it gets turned off
when the measurement says it does not.** Two of the six strategies here have been retired
by that rule. Their code and their evidence are still in the repo, marked as dead, so I
do not rediscover the same bad idea in six months.

---

## The evidence bar

Every strategy directory opens with a header comment stating what was measured, over what
window, on what sample size, and what would cause the strategy to be retired. The bar is
roughly 200 trades. Anything below that is treated as noise, no matter how good the
percentage looks.

Things this rule has already killed:

- **EMA 9/21 crossover with VWAP and relative volume**, the strategy this repo originally
  ran. Negative expectancy in all thirty configurations tested. Replaced by the opening
  range breakout.
- **A daily "hot name" screener gating breakout entries.** It made results worse, not
  better. Yesterday's most active names select for the next day's chop.
- **RSI-pullback swing signals.** Looked fine until I counted signals that actually fell
  inside the live entry window. Eighteen trades per year at a tenth of a basis point.
  Indistinguishable from zero, which matched the live result exactly: zero trades in
  eleven sessions. Retired and replaced.
- **Three of four candidate replacements** for that slot, including the breakout signal
  traded as plain shares. The breakout edge is real but it lives in options leverage. At
  share level it is negative after realistic costs.

Failure findings are written down in the same place as the wins, because the expensive
mistake is re-adopting something that was already disproven.

---

## What runs now

| Strategy | Instrument | Shape | Status |
|---|---|---|---|
| ORB-15 | Options, singles and debit spreads | 15-minute opening range breakout with volume confirmation | Live |
| Overnight momentum | Shares | Buy strength at 15:55 ET, sell at 09:35 ET the next session | Live |
| Overnight drift | Options | Close-to-open drift, long only | Live |
| Credit spread | 0DTE put credit spreads | Defined-risk premium selling | Live, on probation |
| Swing signals | Shares | RSI pullback | Retired, kept for the record |
| Trader mimicry | Options | Insider filings and sentiment, LLM-proposed, code-enforced | Paused |

Each strategy runs from its own directory with its own config, its own API credentials
under its own environment variable names, and its own account. That isolation is
deliberate. Two bots should never be able to cross-wire their credentials or their risk
limits just because someone launched both from one shell.

---

## Where the real work went

**The backtest lied about costs, twice.** The first breakout backtest measured the move in
the underlying stock, not the option I actually buy. The premium stop I had deployed was
never in any simulation. I rebuilt the test to replay the same signals against real
historical option premium bars, which meant writing a resolver that figures out which
contract symbol actually has data near the entry price. Two bugs in the test harness
turned up before any of its output was trustworthy: the stop check was direction-conditional
when the position is always long the option, and the entry premium was anchored to the
market open rather than to the breakout, often an hour later.

**A sign error hid behind a plausible result.** The credit spread bot reported three
winning trades and had actually never held a spread. Alpaca reports a net credit on a
multi-leg fill as a negative fill price, which inverted both exit tests, so every position
closed on a false profit target within half a second of filling. The account was down
seven dollars and the strategy had never been tested. It is on probation with retirement
terms fixed in advance rather than being judged after the fact.

**Live results diverge from backtests for boring reasons.** Option spread cost, theta on
held winners, twenty-second polling granularity on stops, and entry limit orders that
never fill. Those are named in the baseline document so a bad month is not mistaken for a
broken strategy.

**Risk caps live in code, not in judgment.** The one strategy with a language model in the
loop proposes trades to a JSON file. A separate plain script decides whether to place the
order, and it re-checks proposal freshness, entries per day, concurrent positions, the
drawdown guardrail, and the same liquidity and affordability gates the other bots use.
The model gets no ability to talk itself past a limit.

---

## Layout

```
runner.js              ORB-15: the main options bot, 20-second poll loop
lib/                   shared: Alpaca client, market data, contracts, orders,
                       risk manager, indicators, news scoring, screener
strategies/<name>/     one self-contained bot each, own config and credentials
scripts/               backtests, parameter sweeps, Monte Carlo, smoke tests,
                       emergency flatten, report builder, dashboard/tunnel watchdog
status-server.js       small local dashboard over all accounts
phone.html             the same status on a phone, installable to an iPhone
                       home screen (see PHONE-APP.md)
reports/               generated daily HTML reports
```

## Running it

Node 20 or newer, for `--env-file`. There are no dependencies to install.

```
node runner.js --dry-run
node --env-file=strategies/overnight-drift/.env.overnight strategies/overnight-drift/enter.js
node scripts/backtest.js
```

Credentials come from environment variables and are never committed. Each strategy reads
its own pair, for example `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` for ORB-15,
`APCA_SWING_API_KEY_ID` and `APCA_SWING_SECRET_KEY` for swing signals, and so on. Market
news uses `FINNHUB_API_KEY`. Set `LIVE_MODE` only if you intend real orders.

The dashboard runs at `http://localhost:4321`: `/` is the ORB-15 console, `/multi` the
four-bot portfolio view, and `/phone` a layout for an iPhone that can be added to the home
screen and used to watch the bots, or close a position, from away from the desk.
[PHONE-APP.md](PHONE-APP.md) covers installing it.

These are paper accounts and this is a personal research project. Nothing here is
financial advice.
