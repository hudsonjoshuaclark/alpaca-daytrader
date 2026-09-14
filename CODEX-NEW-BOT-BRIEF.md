# Brief: build an intraday options day-trading bot (Alpaca paper), fully backtested

Build a complete, self-contained intraday options day-trading bot for the Alpaca **paper**
API, in Node.js, plus its supervision agents and a status website. You own every numeric
choice — universe, signal, thresholds, stops, sizing, expiries. Do not ask me to pick
parameters; pick them yourself and justify each from your own backtests.

The goal is the highest return you can achieve **that survives honest validation**, not the
highest backtest number. A strategy you can defend at +2%/month beats one that backtests at
+60%/month and is wrong.

**Do not ask me for an API key yet.** Build and backtest everything first. Read credentials
from a `.env` file that does not exist yet, fail with a clear message if it is missing, and
tell me when you are ready for the key. All historical data you need for backtesting is
available from Alpaca's data API with the same credentials, so structure the work so the
research runs the moment I supply them.

---

## 1. What to build

1. **The bot** — a long-running runner that polls during market hours, generates signals,
   sizes positions, places orders, manages open positions, and flattens before the close.
2. **A watchdog** — an independent process/scheduled task that detects a dead or wedged
   runner and restarts it, with escalating behaviour and a last-resort "flatten everything"
   failsafe. It must not be able to start a second runner alongside a live one.
3. **A nightly review agent** — a scripted, non-interactive review that runs after the
   close, reconciles the day, checks health, and writes a dated report. Define its protocol
   in a markdown file the agent reads. See §5 for what it must and must not conclude.
4. **A status website** — see §6.
5. **Backtest and validation scripts** — see §3 and §4. These are the core deliverable, not
   an afterthought. A bot without a defensible backtest is worthless.
6. **A README** documenting the strategy, every parameter with its justification, how to
   run each piece, and what would falsify the strategy.

## 2. Strategy latitude

Intraday, options-based, flat by the close. Beyond that, choose. Some directions worth
considering, but pick on evidence, not on this list:

- Opening-range breakout, VWAP reversion, momentum continuation, gap fade/continuation.
- **Selling** premium (defined-risk credit spreads) rather than buying it — see §7, this
  matters more than it may appear.
- Any mechanism you can validate.

Constraints: US equities/ETFs, liquid underlyings, Alpaca-tradeable options, defined risk
per trade, no naked short options, flat overnight.

## 3. Backtesting requirements

Use **real historical option premium bars** (`/v1beta1/options/bars`), not a theoretical
payoff model, for anything you claim about option returns. Backtesting the underlying and
multiplying by an assumed leverage is not acceptable as a final answer — see §7.

**Pre-register your acceptance standards in writing before you look at any result.** Put
them in the README. Suggested shape (tighten as you see fit):

- n >= 200 trades, and >= 100 trades/year
- positive in-sample AND out-of-sample on a chronological split
- >= 50% of months positive
- expectancy that survives a realistic transaction-cost charge

**Then hold yourself to them.** If your best candidate fails, say so and try a different
mechanism. Reporting "this did not clear the bar" is a successful outcome of this brief.

## 4. Validation traps — these have all been paid for already

This is the most important section. Each item below is a real failure from a comparable
project. Your backtest must be built so that it cannot commit them.

**4.1 Look-ahead.** Advancing a trailing stop on a bar's HIGH parks the stop under the
intrabar peak and books exits a polling bot can never achieve. Use the bar CLOSE, or a
price the market actually held. Any rule that improves as it gets tighter is a look-ahead
signature, not an edge.

**4.2 Signal on closed bars only.** Live data feeds include the still-forming current bar.
Its close is provisional and its volume is partial. A freshness guard must reject bars that
have not closed yet (`now < barCloseMs`), not merely bars that are too old. A prior bot had
64% of its live entries fire on unclosed bars, trading a signal its backtest never modelled.

**4.3 Boundary optima.** If the best cell of a parameter grid sits at the grid's edge, you
have not found an optimum, you have found the edge. Extend the grid until the optimum is
interior, or reject it. Prefer parameters where expectancy **decays smoothly** across
neighbouring values; a value that spikes at exactly one setting and is negative on either
side is fitted noise.

**4.4 Generalisation test.** Validate on a universe your parameters were NOT fitted to. A
prior strategy scored +8.0bp on its own 12 names and +3.2bp on 44 others — it did not
generalise and was correctly rejected. A strategy that scores as well or better off-sample
universe is far more credible.

**4.5 Transaction costs are usually the whole story.** Model them explicitly and sweep
them. Report expectancy at 0%, and at realistic and pessimistic cost levels. If the edge
only survives at zero cost, there is no edge.

**4.6 Fat tails break mean-based statistics.** Long-option returns are convex: bounded at
-100%, unbounded above. Consequences you must respect:
  - Report **median and quantiles**, not just the mean. A prior sim had mean +28.1% and
    median -3.0%, with the top 1% of trades supplying a third of the mean.
  - Ordinary least squares on option returns is invalid and will report a phantom positive
    intercept. Do not fit one.
  - State how much of your expectancy comes from the best 1% of trades. If most of it does,
    say so prominently — that is a lottery-ticket profile, and it needs a much longer
    evaluation window and much smaller sizing.

**4.7 Win rate is a low-power statistic.** Do not validate or monitor on it. Use expectancy
with a t-statistic. A prior bot's win rate sat ~1.3 SE from its baseline (read as "noise",
eight nights running) while its expectancy was 5.2 SE below it.

**4.8 Survivorship.** If your universe is today's liquid names applied to a year of history,
say so as a known bias.

## 5. Live-vs-backtest honesty

**5.1 Book P&L at the FILL, never at the mark.** If exits are market orders they fill at the
bid while the position marks at the mid. A prior bot recorded every exit roughly half a
spread better than reality, which corrupted its realised P&L, its daily loss stop, and every
expectancy figure it was judged on. Read the fill back off the order and record it. Log the
mark alongside so the gap stays measurable.

**5.2 Record the bid/ask you actually accept**, at entry and at exit, from the very first
trade. A prior project could not evaluate its own spread cap after a month of live trading
because it never stored the spread. This costs nothing at build time and is invaluable later.

**5.3 Circuit breakers must be able to fire.** A drawdown pause anchored to a static
"initial capital" value stops measuring drawdown the moment the account moves — it becomes
return-since-inception. Trail a **high-water mark**. Verify a breaker can trip by testing it
against a throwaway state file.

**5.4 Test code must never touch live state.** A prior smoke test called a risk-gate query
with a hardcoded equity value; the "query" persisted its decision and silently paused the
live bot. Make state paths injectable and point tests at temporary files.

**5.5 Degrade, do not die.** A failed API call for account or positions data must not abort
the tick and skip stop management and the end-of-day flatten. With a position open, exiting
matters more than entering: keep managing, suppress new entries, log the degraded state.

**5.6 Handle partial fills.** An order can be partially filled and then cancelled; its
terminal status is `canceled` with a non-zero `filled_qty`. Adopt what was filled as a
managed position. Never drop a position on order status alone.

**5.7 One runner.** Guard against two instances trading the same account. Guard `main()`
behind an entry-point check so importing the module for tests does not start a live loop.

## 6. The website

A local status site (served by the bot's own process or a sibling) showing everything:

- Current equity, day P&L, open positions with live marks, and the drawdown vs high-water mark
- Full trade history with entry/exit prices, **fill vs mark**, and the spread accepted
- Cumulative equity curve, per-trade return distribution (a histogram — the shape matters
  more than the mean), and exit-reason breakdown
- Health: runner heartbeat age, last error, whether trading is paused and why
- The live-vs-backtest comparison on **expectancy with a t-statistic**, updated as trades accrue

Make it genuinely readable — this is the instrument panel, so legibility beats decoration.
Charts should be honest about uncertainty: show confidence intervals or sample size wherever
you show an estimate. Dark and light both fine; pick one and do it properly. No external CDN
dependencies; keep it self-contained and offline-capable.

## 7. A specific warning about buying options

Work this arithmetic for your candidate strategy before committing to it, and put the result
in the README.

A near-dated ATM option costs roughly 1% of spot and moves roughly 40–50x the underlying's
percentage move. So an underlying edge of E basis points becomes roughly `E x 48` basis
points of premium, gross. Against that:

- Entry and exit each pay part of the bid-ask. A market exit pays the full half-spread.
- An 8%-wide contract therefore costs ~5% of premium round-trip.
- Time decay is charged on top: measured at **-26.3% of premium** on days the underlying
  moved less than 0.1%.

In the project this brief comes from, a genuine, well-measured +8.1bp underlying edge became
+3.89% gross per trade against up to 5.00% of round-trip friction — the friction alone
exceeded the entire directional edge. Two bots that bought near-dated premium lost money; the
one that sold defined-risk premium did not.

**This does not mean "never buy options."** It means: compute `edge x leverage` against
`round-trip friction + theta` explicitly, and if the margin is thin, prefer a structure that
is not fighting it. Also note that a per-leg spread cap does not bound a multi-leg spread's
net spread — two legs each inside an 8% cap routinely net 15–25%, because the net bid-ask is
the sum of both legs over a smaller net mid. Gate on the net spread of the structure you are
actually trading.

## 8. Sizing

Size from your measured edge and its uncertainty, not from the backtest's point estimate.
Geometric growth is `E[ln(1 + f*r)]`, not `f * E[r]` — a fat left tail compounds far worse
than its mean suggests. At 32% per-trade volatility, 15%-of-equity sizing pays ~6.7%/month in
pure variance drag even at zero edge; 5% pays ~0.8%. Show this calculation for your chosen
`f` and state the drag you are accepting.

Include a hard, lockable risk-cap file that a config guard verifies on every run, so the
nightly agent cannot quietly change risk.

## 9. Deliverables

1. Working bot, watchdog, nightly review agent, website.
2. Backtest + validation scripts, re-runnable, with cached data so re-runs are cheap.
3. README: the strategy, every parameter and its justification, pre-registered standards and
   whether they were met, the §7 arithmetic, the §8 sizing calculation, known weaknesses, and
   what would falsify the strategy.
4. A short honest summary of what you expect this to return per month and the uncertainty on
   that number. If your answer is "flat, with wide error bars," say that.
5. Tell me when you are ready for the Alpaca paper key, and exactly which env vars to set.

**Do not place a live order, paper or otherwise, until I have supplied the key and confirmed.**

## 10. How I will judge this

Not by the backtest number. By whether the validation would have caught the failures in §4
and §5, and whether the README's stated weaknesses match what the code actually does. If you
cannot find a strategy that clears your own pre-registered bar, deliver the infrastructure
plus an honest negative result. That is a good outcome and I will treat it as one.
