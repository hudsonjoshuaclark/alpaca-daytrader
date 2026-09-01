// ORB-15 options day trader.
// Strategy replaced 2026-07-16: the original EMA9/21 crossover showed negative expectancy
// in every backtested configuration (scripts/sweep.js), while a 15-min opening range
// breakout with volume confirmation on liquid large-caps showed +8bp/trade over 90 days
// (scripts/sweep2.js, sweep3.js). Entries are limit orders at mid+quarter-spread; expensive
// underlyings are traded as vertical debit spreads so a $1000 account can access the names
// that actually carry the edge (TSLA/META/MSFT/COIN/MSTR).
// The news layer (lib/news.js + lib/newsScoring.js) is kept as a FILTER and EXIT trigger:
// high-confidence contradicting news blocks entries and forces exits. News-originated
// entries were removed — no backtest evidence behind keyword-scored headlines as an
// entry signal, unlike the ORB entry they'd be bypassing.
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/config');
const md = require('./lib/marketData');
const contracts = require('./lib/contracts');
const rm = require('./lib/riskManager');
const orders = require('./lib/orders');
const ratchet = require('./lib/ratchet');
const news = require('./lib/news');
const { scoreHeadline } = require('./lib/newsScoring');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');
const HEARTBEAT_FILE = path.join(__dirname, 'logs', 'heartbeat.json');
const POLL_MS = 20 * 1000;

function writeHeartbeat() {
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: new Date().toISOString() }));
}

function log(event, details) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function isMarketHours() {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return false;
  const t = rm.nowET();
  return t >= '09:30' && t < '16:00';
}

// Fetches new articles since last check and scores each, keeping the highest-confidence
// signal per symbol. Returns { SYMBOL: {direction, confidence, matched, headline, createdAt} }.
async function getNewsSignals(symbols) {
  let articles;
  try {
    articles = await news.getNewArticles(symbols);
  } catch (e) {
    log('NEWS_FETCH_ERROR', { message: e.message });
    return {};
  }

  const bySymbol = {};
  for (const article of articles) {
    const score = scoreHeadline(article.headline);
    if (!score.direction) continue;
    for (const sym of article.symbols) {
      if (!symbols.includes(sym)) continue;
      const existing = bySymbol[sym];
      const isUpgrade = !existing || (score.confidence === 'high' && existing.confidence === 'low');
      if (isUpgrade) {
        bySymbol[sym] = { ...score, headline: article.headline, createdAt: article.createdAt };
      }
    }
  }
  return bySymbol;
}

// A long call and a long put on the SAME underlying largely cancel each other out: the
// call's positive delta is offset by the put's negative one, leaving a straddle that bleeds
// theta and premium for no directional exposure. An ORB breakout signal is a directional
// bet, so holding both sides is never the intent — it silently negates the trade.
//
// The scan loop's tradedUnderlyings/openTrades checks already prevent this on the normal
// path, but both read STATE, and riskManager.loadState() wipes both on date rollover. A
// position that outlives the 15:45 force-flatten — a flatten that errored, or the machine
// asleep through it (which has happened here) — is invisible to them the next morning, and
// nothing would stop the bot buying the opposing side. Manually-entered legs (see the
// customStopUsd path) are likewise absent from tradedUnderlyings.
//
// So this reads the ACCOUNT rather than state, and therefore holds no matter what state
// says. Spread legs are safe: a debit call spread is long+short CALLS, same type, so only a
// genuine call-vs-put clash on one underlying trips it.
const OCC_SYMBOL_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

function opposingOptionPositions(underlying, direction, positionsBySymbol) {
  const wantType = direction === 'bullish' ? 'call' : 'put';
  const clashes = [];
  for (const [sym, pos] of positionsBySymbol) {
    if (!OCC_SYMBOL_RE.test(sym)) continue; // not an option (defensive; this account is options-only)
    const parsed = contracts.parseOccSymbol(sym);
    if (parsed.root !== underlying) continue;
    if (parsed.type === wantType) continue;
    if (parseInt(pos.qty, 10) === 0) continue;
    clashes.push({ symbol: sym, type: parsed.type, qty: pos.qty });
  }
  return clashes;
}

// Log the block once per symbol per day rather than every 20s poll until the cutoff.
// Deliberately does NOT consume the symbol's one ORB attempt: this is a safety interlock,
// not a strategy decision, so if the stale opposing position gets closed the symbol should
// become tradeable again the same day.
let opposingLogDay = null;
const opposingLogged = new Set();
function logOpposingOnce(payload) {
  const today = contracts.todayET();
  if (opposingLogDay !== today) {
    opposingLogDay = today;
    opposingLogged.clear();
  }
  if (opposingLogged.has(payload.symbol)) return;
  opposingLogged.add(payload.symbol);
  log('OPPOSING_POSITION_BLOCKED', payload);
}

// Sum of unrealized P&L across a trade's legs, from a symbol->position map.
// Returns null if no legs are found (position gone — e.g. closed manually).
function tradeUnrealizedPl(trade, positionsBySymbol) {
  let pl = 0;
  let found = 0;
  for (const leg of trade.legs) {
    const pos = positionsBySymbol.get(leg.symbol);
    if (!pos) continue;
    pl += parseFloat(pos.unrealized_pl);
    found += 1;
  }
  return found === 0 ? null : pl;
}

const EXIT_FILL_POLL_ATTEMPTS = 5;
const EXIT_FILL_POLL_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Net proceeds per contract/spread actually received on a close order, or null if the
// order has not (yet) reported a usable fill. For a single that is just filled_avg_price;
// for an mleg it is the net credit, sell legs positive and buy legs negative, which is the
// same sign convention entryDebit was recorded in.
function exitCreditFromOrder(order, kind) {
  if (!order || order.status !== 'filled') return null;
  if (kind !== 'spread') {
    const px = parseFloat(order.filled_avg_price);
    return Number.isFinite(px) ? px : null;
  }
  if (!Array.isArray(order.legs) || order.legs.length === 0) return null;
  let credit = 0;
  for (const leg of order.legs) {
    const px = parseFloat(leg.filled_avg_price);
    if (!Number.isFinite(px)) return null;
    credit += leg.side === 'sell' ? px : -px;
  }
  return credit;
}

// Reads the actual closing fill back off the exit order and returns the realised P&L.
//
// Why this exists: exits go out as MARKET orders (lib/orders.js), which fill at the bid,
// but the `pnl` passed into closeTrade() is the pre-order unrealized_pl snapshot, which
// Alpaca marks at the MID. Every exit was therefore booked roughly half a spread better
// than it actually filled, always in the same direction, and MAX_SPREAD_PCT admits
// contracts up to 8% wide. The nightly reviews measured the overshoot directly at $2-15
// per trade on 2026-08-25/26/27/28 and deferred the fix four nights running; across the
// first 50 live trades that is a few hundred dollars of real loss that never reached
// state.realizedPnL, and therefore never reached DAILY_LOSS_STOP_PCT, the equity
// reconciliation in the nightly reports, or any expectancy figure the strategy is judged
// on. Booking the mark instead of the fill does not just mis-report; it biases every
// decision made from the numbers.
//
// Safety: the close order is ALREADY SUBMITTED before this runs, so nothing here can
// delay or prevent an exit - the worst case is that the fill is not readable in time and
// we fall back to the snapshot, exactly the old behaviour, with the source recorded in
// the log. Bounded at ~1.5s so several exits in one tick cannot overrun the 20s poll.
async function realizedFromCloseOrder(orderId, trade, fallbackPnl) {
  if (!orderId) return { pnl: fallbackPnl, source: 'mark_snapshot', exitCredit: null };
  for (let attempt = 0; attempt < EXIT_FILL_POLL_ATTEMPTS; attempt += 1) {
    await sleep(EXIT_FILL_POLL_MS);
    let order;
    try {
      order = await orders.getOrder(orderId);
    } catch (e) {
      log('ERROR', { message: `exit order lookup ${orderId}: ${e.message}` });
      continue;
    }
    const credit = exitCreditFromOrder(order, trade.kind);
    if (credit !== null) {
      return {
        pnl: Math.round((credit - trade.entryDebit) * 100 * trade.qty * 100) / 100,
        source: 'fill',
        exitCredit: credit,
      };
    }
    if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      // The close did NOT go through and the position is still live, but recordExit()
      // below has already dropped it from state.openTrades. It is recovered by the
      // untracked-leftover sweep at FORCE_FLATTEN_AT; surface it loudly in the meantime.
      log('EXIT_ORDER_FAILED', {
        underlying: trade.underlying,
        symbol: trade.legs[0].symbol,
        orderId,
        status: order.status,
        message: 'close order did not fill - position may still be open until the flatten sweep',
      });
      return { pnl: fallbackPnl, source: 'mark_snapshot_close_failed', exitCredit: null };
    }
  }
  return { pnl: fallbackPnl, source: 'mark_snapshot_fill_timeout', exitCredit: null };
}

async function closeTrade(trade, pnl, reason, state, extra = {}) {
  let realized = { pnl, source: 'dry_run_mark', exitCredit: null };
  if (!DRY_RUN) {
    const placed =
      trade.kind === 'spread'
        ? await orders.closeSpreadMarket(trade.legs, trade.qty)
        : await orders.sellToClose(trade.legs[0].symbol, trade.qty);
    realized = await realizedFromCloseOrder(placed && placed.id, trade, pnl);
  }
  rm.recordExit(state, trade.orderId, realized.pnl);
  log(reason === 'force_flatten' ? 'FORCE_FLATTEN' : 'EXIT', {
    symbol: trade.legs[0].symbol,
    underlying: trade.underlying,
    kind: trade.kind,
    reason,
    qty: trade.qty,
    pnl: realized.pnl,
    // Kept alongside so the fill-vs-mark gap is measurable directly from the log rather
    // than re-derived: pnlAtMark is what every exit before 2026-08-30 recorded.
    pnlAtMark: pnl,
    pnlSource: realized.source,
    exitCredit: realized.exitCredit,
    entryDebit: trade.entryDebit,
    dryRun: DRY_RUN,
    ...extra,
  });
}

// Reconcile 'pending' entry orders: promote fills to 'open', drop cancels/rejections,
// cancel anything unfilled past the TTL (the breakout moment has passed).
async function reconcilePendingOrders(state) {
  for (const trade of [...state.openTrades]) {
    if (trade.status !== 'pending') continue;
    if (DRY_RUN) {
      trade.status = 'open';
      rm.saveState(state);
      continue;
    }
    let order;
    try {
      order = await orders.getOrder(trade.orderId);
    } catch (e) {
      log('ERROR', { message: `order lookup ${trade.orderId}: ${e.message}` });
      continue;
    }
    // Promotes a pending trade to managed. `qty` is what we actually own, which is not
    // always what was requested — see the partial-fill branch below.
    const promoteToOpen = (qty, partial) => {
      trade.status = 'open';
      trade.qty = qty;
      trade.entryDebit = parseFloat(order.filled_avg_price) || trade.entryDebit;
      rm.saveState(state);
      // Execution-quality tracking: how far the actual fill landed from the quoted mid
      // at the moment the order was submitted (positive = paid above mid). MAX_SPREAD_PCT
      // already gates on quoted spread at decision time; this measures what the fill
      // itself cost, which quoted spread alone doesn't capture (queue position, moves
      // between quote and fill, partial marketable-limit walk).
      const fillVsMid = trade.quoteMidAtOrder != null ? trade.entryDebit - trade.quoteMidAtOrder : null;
      const fillVsMidPct = fillVsMid != null && trade.quoteMidAtOrder > 0 ? fillVsMid / trade.quoteMidAtOrder : null;
      log('ENTRY', {
        symbol: trade.legs[0].symbol,
        underlying: trade.underlying,
        kind: trade.kind,
        direction: trade.direction,
        qty: trade.qty,
        premium: trade.entryDebit,
        orMid: trade.orMid,
        quoteMidAtOrder: trade.quoteMidAtOrder,
        spreadPctAtOrder: trade.spreadPctAtOrder,
        fillVsMid,
        fillVsMidPct,
        partialFill: partial || undefined,
        requestedQty: partial ? trade.requestedQty : undefined,
        dryRun: false,
      });
    };

    // filled_qty survives cancellation: an order can be PARTIALLY filled and then canceled,
    // and the terminal status is 'canceled' with a non-zero filled_qty.
    const filledQty = parseInt(order.filled_qty, 10) || 0;

    if (order.status === 'filled') {
      promoteToOpen(trade.qty, false);
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      if (filledQty > 0) {
        // A partial fill used to be silently abandoned. `partially_filled` is not in the
        // 'filled' branch, so the trade stayed 'pending' until ENTRY_ORDER_TTL_MS, got
        // canceled, and then landed here — where removeTrade() dropped it on the basis of
        // the status alone, ignoring filled_qty. The contracts were really owned: no
        // option_stop, no or_mid_stop, no ratchet, no concurrency slot, and nothing would
        // have closed them before the 15:45 untracked sweep. Never observed live (all 15
        // ENTRY_UNFILLED events so far had filled_qty 0), but a multi-contract marketable
        // limit is exactly the order type that partial-fills. Adopt what we own instead.
        trade.requestedQty = trade.qty;
        log('ENTRY_PARTIAL_FILL', {
          underlying: trade.underlying,
          orderId: trade.orderId,
          status: order.status,
          requestedQty: trade.qty,
          filledQty,
          message: 'adopting the filled quantity as a managed position',
        });
        promoteToOpen(filledQty, true);
      } else {
        rm.removeTrade(state, trade.orderId);
        log('ENTRY_UNFILLED', { underlying: trade.underlying, orderId: trade.orderId, status: order.status });
      }
    } else if (Date.now() - new Date(trade.enteredAt).getTime() > cfg.ENTRY_ORDER_TTL_MS) {
      try {
        await orders.cancelOrder(trade.orderId);
      } catch (e) {
        if (e.status !== 404 && e.status !== 422) throw e;
      }
      // removal happens on the next reconcile pass, in case it filled while canceling
      log('ENTRY_CANCEL_STALE', { underlying: trade.underlying, orderId: trade.orderId });
    }
  }
}

async function flattenAll(state, positionsBySymbol) {
  for (const trade of [...state.openTrades]) {
    if (trade.status === 'pending') {
      if (!DRY_RUN) {
        try {
          await orders.cancelOrder(trade.orderId);
        } catch (e) {
          if (e.status !== 404 && e.status !== 422) throw e;
        }
      }
      rm.removeTrade(state, trade.orderId);
      continue;
    }
    const pnl = tradeUnrealizedPl(trade, positionsBySymbol) ?? 0;
    await closeTrade(trade, pnl, 'force_flatten', state);
    for (const leg of trade.legs) positionsBySymbol.delete(leg.symbol);
  }
  // safety sweep: anything in the account not tracked in state
  for (const pos of positionsBySymbol.values()) {
    const qty = Math.abs(parseInt(pos.qty, 10));
    if (qty <= 0) continue;
    if (!DRY_RUN) await orders.closePositionMarket(pos.symbol);
    log('FORCE_FLATTEN', { symbol: pos.symbol, qty, pnl: parseFloat(pos.unrealized_pl), untracked: true });
  }
}

async function manageOpenTrades(state, positionsBySymbol, bars, newsSignals) {
  for (const trade of [...state.openTrades]) {
    if (trade.status !== 'open') continue;

    const pl = tradeUnrealizedPl(trade, positionsBySymbol);
    if (pl === null) {
      if (!DRY_RUN) {
        // A trade whose legs have vanished was closed outside the bot - the dashboard's
        // manual Close button, or anything done in Alpaca's own UI. This used to call bare
        // removeTrade(), which drops the position WITHOUT adding its P&L to
        // state.realizedPnL (unlike recordExit(), which every bot-initiated exit uses).
        // That is not just a display gap: canEnterNewTrade() reads state.realizedPnL for
        // the DAILY_LOSS_STOP_PCT circuit breaker, so a large externally-closed LOSS would
        // silently fail to trip the daily loss stop and the bot would keep entering.
        // Confirmed live 2026-07-24 - a manual close moved equity $1003 -> $2362 while
        // realizedPnL stayed at 0.
        //
        // lastSeenPl is this trade's unrealised P&L from the most recent tick that still
        // saw its legs, so it is at most one poll interval stale. Recorded as an estimate
        // rather than left out entirely: a slightly-off number keeps the circuit breaker
        // working, a missing one disables it.
        const estimated = typeof trade.lastSeenPl === 'number' ? trade.lastSeenPl : 0;
        rm.recordExit(state, trade.orderId, estimated);
        log('TRADE_GONE', {
          underlying: trade.underlying,
          message: 'no legs found in account positions - closed outside the bot',
          pnl: estimated,
          pnlIsEstimate: true,
          pnlSource: typeof trade.lastSeenPl === 'number' ? 'last observed unrealized_pl' : 'none available, counted as 0',
        });
      }
      continue;
    }

    // Remembered so the TRADE_GONE branch above has a P&L to record if this position is
    // closed outside the bot before the next tick. Persisted (rather than kept in memory)
    // so it also survives a runner restart while a position is open.
    if (trade.lastSeenPl !== pl) {
      trade.lastSeenPl = pl;
      rm.saveState(state);
    }

    // per-trade custom $ stop/target (optional - only set on manually-entered trades that
    // don't fit the standard orMid/OPTION_STOP_PCT model, e.g. a naked single leg entered
    // outside a fresh ORB signal). Absolute dollar thresholds, not percentages.
    if (typeof trade.customStopUsd === 'number' && pl <= trade.customStopUsd) {
      await closeTrade(trade, pl, 'custom_stop', state);
      continue;
    }
    if (typeof trade.customTargetUsd === 'number' && pl >= trade.customTargetUsd) {
      await closeTrade(trade, pl, 'custom_target', state);
      continue;
    }

    // high-confidence news contradicting the held direction forces an immediate exit
    const newsForSymbol = newsSignals[trade.underlying];
    if (newsForSymbol && newsForSymbol.confidence === 'high' && newsForSymbol.direction !== trade.direction) {
      await closeTrade(trade, pl, 'news_exit', state, { headline: newsForSymbol.headline });
      continue;
    }

    // catastrophic option-level stop on combined premium
    const costBasis = trade.entryDebit * 100 * trade.qty;
    if (costBasis > 0 && pl / costBasis <= -cfg.OPTION_STOP_PCT) {
      await closeTrade(trade, pl, 'option_stop', state);
      continue;
    }

    // Ratcheting profit floor. Purely additive: minStopRung 1 means rung 0 has no stop of
    // its own, so a trade that never runs is governed by exactly the exits it always was.
    // Once premium clears a rung, the floor rides up behind it and can close the trade
    // before the or_mid_stop below gives the gains back.
    if (cfg.RATCHET_ENABLED && costBasis > 0) {
      const r = ratchet.evaluate({
        rung: trade.rung || 0,
        gain: pl / costBasis,
        step: cfg.RATCHET_STEP_PCT,
        stopDistance: cfg.RATCHET_STOP_PCT,
        maxRungs: cfg.RATCHET_MAX_RUNGS,
        minStopRung: 1,
      });
      if (r.advanced) {
        trade.rung = r.rung;
        rm.saveState(state);
        log('RATCHET', {
          symbol: trade.legs[0].symbol, underlying: trade.underlying, rung: r.rung,
          gainPct: +((pl / costBasis) * 100).toFixed(2),
          stopPct: +(r.stop * 100).toFixed(2), targetPct: +(r.target * 100).toFixed(2), pnl: pl,
        });
      }
      if (r.stopped) {
        await closeTrade(trade, pl, 'trail_stop', state, { rung: r.rung });
        continue;
      }
    }

    // primary exit: underlying crossed back through the opening-range midpoint
    const underlyingBars = bars[trade.underlying];
    if (underlyingBars && underlyingBars.length > 0) {
      const last = underlyingBars[underlyingBars.length - 1];
      const barDay = new Date(last.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      // Skip while `last` is still the entry/breakout bar — its wick can be past orMid
      // from before it closed above orHigh, which predates the trade (backtest excludes
      // this bar too; live didn't, see logs/trade-log.jsonl 2026-08-11 and 2026-08-13).
      if (barDay === contracts.todayET() && last.t !== trade.barTime) {
        const crossed = trade.direction === 'bullish' ? last.l <= trade.orMid : last.h >= trade.orMid;
        if (crossed) {
          await closeTrade(trade, pl, 'or_mid_stop', state);
        }
      }
    }
  }
}

const RELSTRENGTH_INDEX_SYMBOL = 'SPY';
const RELSTRENGTH_EXEMPT = new Set(['SPY', 'QQQ']); // these ARE the benchmark

async function tryEnter(symbol, bars, portfolioValue, state, newsForSymbol, indexBars, positionsBySymbol) {
  const signal = md.computeORBSignal(bars);
  if (!signal) return;

  // Hard interlock: never add the opposite option type on an underlying we already hold.
  // Checked before contract selection so a clash costs no API calls. positionsBySymbol is
  // refetched at the top of every tick, so it is at most one poll (~20s) stale, and the
  // scan loop already allows only one entry per symbol per tick — there is no window for
  // this bot to open both sides between two checks.
  const opposing = opposingOptionPositions(symbol, signal.direction, positionsBySymbol);
  if (opposing.length) {
    logOpposingOnce({
      symbol,
      direction: signal.direction,
      wouldBuy: signal.direction === 'bullish' ? 'call' : 'put',
      heldOpposing: opposing.map((o) => `${o.symbol} (${o.type} x${o.qty})`),
      message: 'would negate the existing position — entry blocked',
    });
    return;
  }

  // Relative-strength-vs-SPY filter, validated 2026-07-28 (see lib/marketData.js
  // computeRelativeStrength for the backtest numbers): a breakout fighting the index's
  // own move at that moment is lower quality. SPY/QQQ are exempt - they ARE the benchmark.
  if (!RELSTRENGTH_EXEMPT.has(symbol) && indexBars) {
    const rs = md.computeRelativeStrength(bars, indexBars, signal);
    if (rs && !rs.aligned) {
      log('RELSTRENGTH_BLOCKED', {
        symbol,
        direction: signal.direction,
        symPct: +(rs.symPct * 100).toFixed(2),
        indexPct: +(rs.indexPct * 100).toFixed(2),
      });
      if (!state.tradedUnderlyings.includes(symbol)) {
        state.tradedUnderlyings.push(symbol);
        rm.saveState(state);
      }
      return;
    }
  }

  // news contradicting the breakout direction blocks the entry (any confidence tier)
  if (newsForSymbol && newsForSymbol.direction && newsForSymbol.direction !== signal.direction) {
    log('NEWS_BLOCKED', {
      symbol,
      technicalDirection: signal.direction,
      newsDirection: newsForSymbol.direction,
      newsConfidence: newsForSymbol.confidence,
      headline: newsForSymbol.headline,
    });
    // consumed this symbol's one ORB attempt for the day
    if (!state.tradedUnderlyings.includes(symbol)) {
      state.tradedUnderlyings.push(symbol);
      rm.saveState(state);
    }
    return;
  }

  const gate = rm.canEnterNewTrade(state, portfolioValue, state.openTrades.length);
  if (!gate.allowed) {
    log('SIGNAL_BLOCKED', { symbol, direction: signal.direction, reasons: gate.reasons });
    return;
  }

  const budget = rm.tradeBudget(portfolioValue);
  const { structure, reason } = await contracts.selectStructure(
    symbol,
    signal.direction,
    signal.price,
    budget,
    md.getLatestOptionQuote
  );
  if (!structure) {
    log('NO_STRUCTURE', { symbol, direction: signal.direction, budget: budget.toFixed(0), reason });
    // consumed this symbol's one ORB attempt for the day — matches the backtest,
    // which took the first breakout bar or nothing
    if (!state.tradedUnderlyings.includes(symbol)) {
      state.tradedUnderlyings.push(symbol);
      rm.saveState(state);
    }
    return;
  }

  if (cfg.SMALL_ACCOUNT_MODE && cfg.SMALL_ACCOUNT_REQUIRE_MANUAL_APPROVAL) {
    log('TRADE_PROPOSED', { symbol, kind: structure.kind, direction: signal.direction, qty: structure.qty });
    return;
  }

  let limitPrice;
  let quoteMid;
  // The bid/ask ACTUALLY ACCEPTED at the gate, recorded so the MAX_SPREAD_PCT question can
  // eventually be answered from data. As of 2026-08-31 it cannot be: logs/option-cache-orb.js
  // holds OHLC bars with no contemporaneous quotes, and the trade log never kept the spread
  // it accepted, so the 0/4/8% cost grids in the sweeps are a MODELLED cost, not a measured
  // one. scripts/orb-leverage-vs-friction.js shows why this matters - at an 8% spread the
  // round-trip friction (5.0% of premium) exceeds the entire gross directional edge that
  // +8.1bp of underlying edge buys at 48x option leverage (3.89%). That is a hypothesis
  // until these fields exist for a few hundred trades. Costs nothing: the quote is already
  // in hand here.
  //
  // The EXIT side needs no new field - EXIT already logs pnl (the fill) alongside pnlAtMark
  // (the mid-mark), and their difference IS the realised half-spread paid to get out.
  let quoteBid;
  let quoteAsk;
  if (structure.kind === 'single') {
    quoteMid = structure.quote.mid;
    quoteBid = structure.quote.bid;
    quoteAsk = structure.quote.ask;
    limitPrice = orders.entryLimitFromQuote(structure.quote);
  } else {
    quoteMid = structure.quote.long.mid - structure.quote.short.mid;
    // Net debit paid at the worst of both legs vs received at the best of both.
    quoteBid = structure.quote.long.bid - structure.quote.short.ask;
    quoteAsk = structure.quote.long.ask - structure.quote.short.bid;
    limitPrice = orders.roundTick(quoteMid + 0.25 * (quoteAsk - quoteMid));
  }
  const spreadPctAtOrder = quoteMid > 0 ? +(((quoteAsk - quoteBid) / quoteMid) * 100).toFixed(2) : null;

  // MAX_SPREAD_PCT is enforced PER LEG in lib/contracts.js:99, but for a two-leg debit
  // vertical the net bid-ask is the SUM of both legs' absolute spreads measured against a
  // net mid SMALLER than either leg's. Two legs each comfortably inside an 8% cap routinely
  // net out at 15-25%, so the gate does not bound what it appears to bound on this path -
  // and the spread path is used precisely for the expensive names (TSLA/META/MSFT/COIN/MSTR)
  // that a small account cannot reach with a single. Live, n is tiny but points the same
  // way: singles -2.02%/trade (n=44) vs spreads -15.39%/trade (n=6).
  //
  // Deliberately WARNS rather than blocks. Net-spread gating would silently drop the
  // expensive half of the universe, and how many signals that costs cannot be measured
  // from the existing cache (OHLC bars, no quotes). This makes the breach visible on the
  // first occurrence so the decision can be made from data rather than from this comment.
  if (structure.kind === 'spread' && spreadPctAtOrder != null && spreadPctAtOrder > cfg.MAX_SPREAD_PCT) {
    log('NET_SPREAD_OVER_CAP', {
      symbol,
      netSpreadPct: spreadPctAtOrder,
      maxSpreadPct: cfg.MAX_SPREAD_PCT,
      legSpreadPct: {
        long: +(((structure.quote.long.ask - structure.quote.long.bid) / structure.quote.long.mid) * 100).toFixed(2),
        short: +(((structure.quote.short.ask - structure.quote.short.bid) / structure.quote.short.mid) * 100).toFixed(2),
      },
      message: 'both legs passed the per-leg cap but the net spread exceeds it - not blocked, see runner.js',
    });
  }
  if (limitPrice <= 0) {
    log('NO_STRUCTURE', { symbol, reason: 'non-positive limit price' });
    return;
  }

  let orderId = `dry-${Date.now()}`;
  if (!DRY_RUN) {
    const placed =
      structure.kind === 'single'
        ? await orders.buyToOpenLimit(structure.legs[0].symbol, structure.qty, limitPrice)
        : await orders.openSpreadLimit(structure.legs, structure.qty, limitPrice);
    orderId = placed.id;
  }

  rm.recordEntry(state, {
    underlying: symbol,
    kind: structure.kind,
    legs: structure.legs,
    qty: structure.qty,
    direction: signal.direction,
    orMid: signal.orMid,
    barTime: signal.barTime,
    entryDebit: limitPrice,
    quoteMidAtOrder: quoteMid,
    quoteBidAtOrder: quoteBid,
    quoteAskAtOrder: quoteAsk,
    spreadPctAtOrder,
    orderId,
    status: 'pending',
    enteredAt: new Date().toISOString(),
  });
  log('ENTRY_ORDER', {
    symbol,
    kind: structure.kind,
    legs: structure.legs.map((l) => `${l.side} ${l.symbol}`),
    direction: signal.direction,
    qty: structure.qty,
    limitPrice,
    rvol: signal.rvol.toFixed(2),
    // Which bar produced this signal, and how long after that bar CLOSED the order went
    // out. Added 2026-08-30: the still-forming-bar bug in lib/marketData.js could only be
    // detected by inferring bar alignment from ENTRY_ORDER timestamps, because barTime was
    // never logged. barAgeSec must now always be >= 0; a negative value means the
    // closed-bar guard has regressed.
    barTime: signal.barTime,
    barAgeSec: Math.round((Date.now() - (new Date(signal.barTime).getTime() + 5 * 60 * 1000)) / 1000),
    quoteBid,
    quoteAsk,
    spreadPctAtOrder,
    dryRun: DRY_RUN,
  });
}

// Last successful /v2/positions read, kept so a transient positions outage degrades to
// managing open trades from a slightly stale snapshot instead of skipping management
// entirely. Module-level so it survives across ticks; never persisted, because a
// snapshot from before a restart is too old to make a stop decision from.
let lastPositionsSnapshot = null;

async function tick() {
  writeHeartbeat();
  if (!isMarketHours()) return;
  // Per-tick, not module-level: a stale read must not suppress entries on later ticks.
  let positionsAreStale = false;

  // /v2/account is the call that has actually failed in production (2026-08-10 DNS/TLS,
  // 2026-08-13 timeouts), and letting it throw aborted the ENTIRE tick - including
  // manageOpenTrades' stop checks and the 15:45 flatten. That is precisely backwards: with
  // a position open, exiting matters far more than entering. Equity is only needed to SIZE
  // a new entry, so degrade instead of dying - keep managing and flattening what's open,
  // and skip only new entries until the account call recovers.
  let portfolioValue = null;
  try {
    const equity = parseFloat((await orders.getAccount()).equity);
    if (Number.isFinite(equity)) portfolioValue = equity;
  } catch (e) {
    log('ACCOUNT_UNAVAILABLE', { message: e.message, effect: 'managing open trades only, no new entries this tick' });
  }
  const state = rm.loadState();
  if (state.startEquity === null && portfolioValue !== null) {
    state.startEquity = portfolioValue;
    rm.saveState(state);
  }

  await reconcilePendingOrders(state);

  // /v2/positions gets the SAME degrade-don't-die treatment as /v2/account above, and for
  // a stronger reason. An unguarded throw here reaches the top-level catch in runTick(),
  // which skips manageOpenTrades() AND the 15:45 flatten - so the one endpoint failure
  // that leaves open 0DTE options completely unmanaged was the one still unprotected. The
  // 2026-08-10 outage (ENOTFOUND then ERR_TLS_CERT_ALTNAME_INVALID, ~2h) hit /v2/account
  // and got hardened; nothing about that outage was specific to that path.
  //
  // Falling back to the previous tick's snapshot is deliberate: a stop evaluated on marks
  // up to a poll or two old is worse than a fresh one but far better than no stop check at
  // all, and every exit is a market order that does not depend on the stale price. Entries
  // are suppressed while degraded, since the snapshot cannot prove a position is absent.
  let livePositions = null;
  if (!DRY_RUN) {
    try {
      livePositions = await orders.getAllPositions();
      lastPositionsSnapshot = livePositions;
    } catch (e) {
      if (!lastPositionsSnapshot) {
        log('ERROR', { message: `positions unavailable and no prior snapshot: ${e.message}` });
        return;
      }
      livePositions = lastPositionsSnapshot;
      positionsAreStale = true;
      log('POSITIONS_UNAVAILABLE', {
        message: e.message,
        effect: 'managing open trades from the previous snapshot, no new entries this tick',
      });
    }
  } else {
    livePositions = [];
  }
  const positionsBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));

  if (rm.shouldForceFlatten()) {
    await flattenAll(state, positionsBySymbol);
    const fresh = rm.loadState();
    if (!fresh.dayEndLogged) {
      fresh.dayEndLogged = true;
      rm.saveState(fresh);
      log('DAY_END', { trades: fresh.trades, realizedPnL: fresh.realizedPnL, startEquity: fresh.startEquity });
    }
    return;
  }

  const heldUnderlyings = state.openTrades.map((t) => t.underlying);
  const newsSignals = await getNewsSignals([...new Set([...cfg.UNIVERSE, ...heldUnderlyings])]);
  const bars = await md.getBars(cfg.UNIVERSE);

  await manageOpenTrades(state, positionsBySymbol, bars, newsSignals);

  // entries: one ORB attempt per symbol per day
  // positionsAreStale gates entries as well as portfolioValue: the opposing-position
  // interlock and the concurrency count in tryEnter both read positionsBySymbol, and a
  // stale map cannot prove a position is absent.
  if (portfolioValue !== null && !positionsAreStale && rm.nowET() < cfg.ORB_ENTRY_CUTOFF) {
    for (const symbol of cfg.UNIVERSE) {
      if (state.tradedUnderlyings.includes(symbol)) continue;
      if (state.openTrades.some((t) => t.underlying === symbol)) continue;
      if (!bars[symbol]) continue;
      await tryEnter(symbol, bars[symbol], portfolioValue, state, newsSignals[symbol], bars[RELSTRENGTH_INDEX_SYMBOL], positionsBySymbol);
    }
  }
}

async function main() {
  log('START', { dryRun: DRY_RUN, strategy: 'ORB15', universe: cfg.UNIVERSE });
  // setInterval fires on a fixed clock regardless of whether the previous tick finished.
  // A slow tick (broker 5xx/timeout backoff, a big multi-symbol bar fetch) could therefore
  // run concurrently with the next one — and since a trade is only written to state AFTER
  // its order is placed, two overlapping ticks can both pass the "no open trade for this
  // underlying" check and double-enter the same symbol. Skip instead of stacking.
  let tickInFlight = false;
  const runTick = async () => {
    if (tickInFlight) {
      log('TICK_SKIPPED', { reason: 'previous tick still running' });
      return;
    }
    tickInFlight = true;
    try {
      await tick();
    } catch (e) {
      log('ERROR', { message: e.message });
    } finally {
      tickInFlight = false;
    }
  };
  await runTick();
  setInterval(runTick, POLL_MS);
}

// Only start the live loop when this file IS the process entry point (that is how
// scripts/restart-runner.ps1 launches it). Guarding it means the pure helpers below can be
// required by a test without the requiring process silently becoming a second live runner
// against the same account — which the duplicate-runner checks in the nightly review exist
// precisely to catch.
if (require.main === module) main();

// Exported for tests only. Nothing in the live path imports this module.
module.exports = { exitCreditFromOrder };
