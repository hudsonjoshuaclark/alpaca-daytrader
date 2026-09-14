# Four-bot health check, bug fixes and audit — 2026-08-13 (evening, market closed)

Scope: check all four bots, find and fix errors, audit for improvements.

| Bot | Account equity | Status going in | Verdict |
|---|---|---|---|
| ORB-15 | $2,651.78 | running | Healthy. Tonight's nightly-review fix verified as real. |
| Overnight Drift | $1,049.44 | 2 spreads open | Working. One bookkeeping bug fixed. |
| Credit Spread (0DTE) | $992.48 | running | **Was structurally broken.** Fixed. |
| Swing Signals (RSI) | $1,000.00 | running | **No demonstrated edge.** Measured; no change deployed. |

---

## 1. Critical: the credit-spread bot never held a single position

**Every trade this bot has ever placed round-tripped in under half a second at a loss.**

```
08-06  ENTRY netCredit -0.34  ->  EXIT profit_target  -$4   (118ms later)
08-11  ENTRY netCredit -0.17  ->  EXIT profit_target  -$2   (290ms later)
08-13  ENTRY netCredit -0.13  ->  EXIT profit_target  -$2   (349ms later)
```

Root cause, verified directly against the Alpaca API rather than inferred. Alpaca reports an
`mleg` fill as a **signed** net price — negative when the combo was opened for a net credit:

```
limit order  limit_price=0.13  filled_avg_price=-0.13
   leg QQQ260813P00719000  sell_to_open  filled 0.25
   leg QQQ260813P00716000  buy_to_open   filled 0.12     -> net credit 0.13
```

`reconcilePendingOrders` stored that raw, so `entryCreditTotal` was **−13**, which inverted
both exit tests in `manageOpenTrades`:

| test | intended | with a negative credit |
|---|---|---|
| profit target `pl >= credit * 0.50` | `pl >= +6.50` | `pl >= −6.50` — true immediately |
| stop `pl <= −credit * (2.0−1)` | `pl <= −13.00` | `pl <= +13.00` — also true |

Both fired at once; `profit_target` is checked first, so it always won. The position was
market-closed instantly, paying the bid-ask spread each time.

**This is why the bot looked like it "wasn't working" — it was trading, then immediately
untrading.** None of its backtested +168bp/trade edge could ever have been harvested.

**Fix** (`strategies/credit-spread/runner.js`): normalise the fill to a positive credit, plus
a guard that refuses to run either exit test on a non-positive credit (it now logs an ERROR
and holds to the 15:45 flatten instead of acting on a nonsensical number).

---

## 2. A broker hiccup could skip stop-losses on all three continuous runners

Every runner opened its tick with `const account = await orders.getAccount()`. An exception
there aborted the **entire** tick — including `manageOpenTrades` (stop-loss / profit-target
checks) and the 15:45 force-flatten. Exactly backwards: with a position open, exiting matters
more than entering.

Not hypothetical. `/v2/account` is the call that has actually failed here:

- 2026-08-10 — ~24 ticks lost to `ENOTFOUND` / `ERR_TLS_CERT_ALTNAME_INVALID`
- 2026-08-13 — swing-signals lost **16 consecutive minutes** (12:56–13:11 ET) to
  `timed out after 20000ms`, every tick

Two fixes:

1. **Equity is only needed to size a new entry.** All three runners now degrade instead of
   dying: they keep reconciling, managing and flattening open positions, and skip *only* new
   entries, logging `ACCOUNT_UNAVAILABLE`.
2. **GET timeouts are now retried once** (`lib/httpClient.js`). Previously an `AbortError`
   threw straight through with no retry — 5xx, 429 and network errors were all retried, but
   a hung connection was not. Bounded at one retry (~40s worst case) so the tick
   re-entrancy guard can absorb it. **POSTs are still never retried on timeout** — a
   mid-flight order may already have been accepted, and a blind retry could double-place a
   live trade.

## 2b. The four `alpacaClient.js` copies are now one shared transport

The four copies were byte-different but **semantically identical** — the differences were
entirely comments. That drift had already caused a real incident: the 2026-07-28 network-retry
fix was applied only to `lib/`, so on 2026-08-05 the three strategy copies still failed with a
bare `fetch failed`.

Retry/timeout logic now lives in `lib/httpClient.js`, which holds **no config and no
credentials**. Each bot's `alpacaClient.js` is a 3-line binding of its own config, so account
isolation is unchanged — and this is verified, not assumed: the test suite asserts all four
clients reach four *distinct* Alpaca account numbers.

`strategies/trader-mimicry/alpacaClient.js` was left alone — that bot is retired, same
precedent as its known stale-quote bug.

---

## 3. Externally-closed trades silently disabled the daily-loss circuit breaker

Known since 2026-07-24 and still live in every bot. When a tracked trade's legs vanish from
Alpaca (the dashboard's manual Close button, or anything done in Alpaca's own UI), the
`TRADE_GONE` branch called bare `removeTrade()` — which does **not** add the trade's P&L to
`state.realizedPnL`, unlike the `recordExit()` every bot-initiated exit uses.

That is not a display bug. `canEnterNewTrade()` reads `state.realizedPnL` for the
`DAILY_LOSS_STOP_PCT` check, so **a large externally-closed loss would silently fail to trip
the daily loss stop** and the bot would keep entering.

The earlier session deferred this for lack of a P&L source at close time. Solved without any
new API call: each runner now persists `lastSeenPl` — the trade's unrealised P&L from the most
recent tick that still saw its legs — and records that on `TRADE_GONE`, explicitly flagged
`pnlIsEstimate: true`. At most one poll interval stale. A slightly-off number keeps the circuit
breaker working; a missing one disables it. Where no observation exists it degrades to 0,
i.e. never worse than the behaviour it replaces.

---

## 4. Overnight Drift: phantom positions between runs

`enter.js` placed its orders at 15:55 ET and exited immediately, leaving every order recorded
as an open position with `status: 'pending'` until the *next morning's* `exit.js` reconciled it.
The orders are `day` limits, so they resolve by the 16:00 close — and they frequently expire:
**3 of the 7 placed between 08-03 and 08-13 never filled.**

Live example from today: state recorded 3 open positions (TSLA, COIN, PLTR) when only COIN and
PLTR ever filled — TSLA expired. `canEnterNewTrade()` counts `openPositions` against
`MAX_CONCURRENT_POSITIONS`, so a phantom silently consumes a slot, and the dashboard reports
it as a real position.

`enter.js` now polls through the close (read-only; nothing is cancelled or re-priced) and
resolves each order to filled or expired before exiting. Today's stale state was reconciled by
hand to match Alpaca: TSLA dropped, COIN @0.82 and PLTR @0.88 marked open.

### Deliberately NOT changed: the 57% fill rate

The obvious "fix" is to re-price unfilled orders toward the ask. **The arithmetic says that
would probably destroy the edge.** Overnight drift is worth ~+13.8bp on the underlying; the
bot expresses it through $2.50-wide debit spreads bought for ~$0.85, where crossing the rest
of the spread costs roughly 6–11% of the debit. That is very likely larger than the edge
itself. The passive limit is not a bug — it is what protects a thin edge, and missing 43% of
signals is the price of not overpaying. Flagged rather than "fixed".

---

## 5. Swing Signals: measured, and it has no edge

Zero trades in 11 live sessions. Its own config already suspected why; this quantifies it.

New tool: `scripts/strategy-swing-signalrate-sweep.js` — 365 days × 56 symbols, counting
**only signals inside the live entry window**, which is precisely what the original validating
sweep failed to do. Exits simulated with the deployed ratchet; 70/30 chronological split as an
overfitting guard.

**Where the signal actually fires** (deployed rule, 344 raw signals):

| window | count | share |
|---|---|---|
| pre-market `<09:30` | 77 | 22.4% |
| open `09:30–09:45` | 228 | 66.3% |
| **live window `09:45–15:30`** | **18** | **5.2%** |
| close / after-hours | 21 | 6.2% |

**Deployed setting: n=18 over 251 trading days → 18 trades/YEAR at +0.1bp/trade.**
Indistinguishable from zero, on a sample an order of magnitude below the 200-trade bar. The
"20.24bp/trade, n=324" figure that justified deployment counted signals the bot structurally
cannot take.

A 24-combo grid (RSI 30/35/40/45 × window 09:35/09:45/10:00 × EMA 50/20) found **no
deployable replacement**:

- `rsi=35` looks best on the surface (n=177, +7.6bp, 53.1% wins) — but its in-sample
  expectancy is **negative** (−3.4bp) and all the edge sits in the last 30% of the sample.
  That is a regime artifact. Nearly every row in the grid shows the same negative-IS /
  positive-OOS signature.
- `rsi=45 / ema=20` rows pass a naive statistical filter but demand ~16,000 trades/year
  (63/day on a $1,000 account) at +1.0bp with **330% max drawdown** — below transaction cost
  and untradeable.

**Nothing was deployed.** Per this repo's standing rule, "no change" beats shipping a fitted
variant. `config.js` and the dashboard note now state the measured reality instead of the
superseded figure.

**Open decision for a human:** retire this bot and repurpose the account, or replace the
strategy outright. Left running for now — it is inert, not dangerous.

---

## 6. Monitoring gaps closed

- **Two of three continuous runners reported no liveness at all.** credit-spread and
  swing-signals both write `logs/heartbeat.json` exactly like ORB-15, but the dashboard never
  read them — a dead runner looked identical to an idle one. Both cards now show a LIVE /
  RUNNER DOWN pill.
- **The missed-entry-window alert was ORB-15-only.** On 2026-08-12 Modern Standby swallowed
  the entire session — *no* bot ran, no `START` in any log — and that was visible on one of
  four cards. Now generalised per bot with each one's own entry cutoff.
- **Overnight Drift had no health signal of any kind.** It is two scheduled scripts, so it has
  no heartbeat; its runs are the only evidence it is alive. New `checkOvernightStale()` flags a
  missed enter/exit run against the calendar. It ran on neither 08-11 nor 08-12 and nothing
  surfaced it.
- **New `scripts/restart-strategy-runner.ps1`.** credit-spread and swing-signals previously had
  no restart script and had to be restarted by hand-matching processes — the operation you
  least want to improvise, since a too-broad match kills the other live bots. Path-anchored
  matching, `node --check` before killing anything, single-instance and fresh-heartbeat
  verification after.

---

## Verification

- `scripts/test-fixes-2026-08-13.js` — **34/34 pass**, including a regression witness that
  reproduces the credit-spread bug with the old code path, POST-never-retried-on-timeout, and
  live confirmation that all four clients hit four distinct accounts.
- `scripts/smoke.js` passes against the refactored client.
- `scripts/guard-config.js` — risk caps intact, paper endpoint confirmed. No locked cap touched.
- `node --check` clean on every modified file.
- All four bots restarted off-hours: exactly one instance each, zero stderr, fresh heartbeats.

## Not done / open

- Swing-signals retire-or-replace — human decision (§5).
- Overnight-drift fill rate — deliberately left alone (§4).
- The 2026-08-12 lost session is the known Modern Standby hardware limit. It is now *visible*;
  it is not fixed, and software cannot fix it.
- Nothing committed to git — no commit was requested.
