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

async function closeTrade(trade, pnl, reason, state, extra = {}) {
  if (!DRY_RUN) {
    if (trade.kind === 'spread') {
      await orders.closeSpreadMarket(trade.legs, trade.qty);
    } else {
      await orders.sellToClose(trade.legs[0].symbol, trade.qty);
    }
  }
  rm.recordExit(state, trade.orderId, pnl);
  log(reason === 'force_flatten' ? 'FORCE_FLATTEN' : 'EXIT', {
    symbol: trade.legs[0].symbol,
    underlying: trade.underlying,
    kind: trade.kind,
    reason,
    qty: trade.qty,
    pnl,
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
    if (order.status === 'filled') {
      trade.status = 'open';
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
        fillVsMid,
        fillVsMidPct,
        dryRun: false,
      });
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { underlying: trade.underlying, orderId: trade.orderId, status: order.status });
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
        rm.removeTrade(state, trade.orderId);
        log('TRADE_GONE', { underlying: trade.underlying, message: 'no legs found in account positions' });
      }
      continue;
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
      if (barDay === contracts.todayET()) {
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
  if (structure.kind === 'single') {
    quoteMid = structure.quote.mid;
    limitPrice = orders.entryLimitFromQuote(structure.quote);
  } else {
    quoteMid = structure.quote.long.mid - structure.quote.short.mid;
    const netWorst = structure.quote.long.ask - structure.quote.short.bid;
    limitPrice = orders.roundTick(quoteMid + 0.25 * (netWorst - quoteMid));
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
    entryDebit: limitPrice,
    quoteMidAtOrder: quoteMid,
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
    dryRun: DRY_RUN,
  });
}

async function tick() {
  writeHeartbeat();
  if (!isMarketHours()) return;

  const account = await orders.getAccount();
  const portfolioValue = parseFloat(account.equity);
  const state = rm.loadState();
  if (state.startEquity === null) {
    state.startEquity = portfolioValue;
    rm.saveState(state);
  }

  await reconcilePendingOrders(state);

  const livePositions = DRY_RUN ? [] : await orders.getAllPositions();
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
  if (rm.nowET() < cfg.ORB_ENTRY_CUTOFF) {
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
  await tick().catch((e) => log('ERROR', { message: e.message }));
  setInterval(() => {
    tick().catch((e) => log('ERROR', { message: e.message }));
  }, POLL_MS);
}

main();
