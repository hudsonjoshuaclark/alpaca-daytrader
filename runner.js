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
      log('ENTRY', {
        symbol: trade.legs[0].symbol,
        underlying: trade.underlying,
        kind: trade.kind,
        direction: trade.direction,
        qty: trade.qty,
        premium: trade.entryDebit,
        orMid: trade.orMid,
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

async function tryEnter(symbol, bars, portfolioValue, state, newsForSymbol) {
  const signal = md.computeORBSignal(bars);
  if (!signal) return;

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
  if (structure.kind === 'single') {
    limitPrice = orders.entryLimitFromQuote(structure.quote);
  } else {
    const netMid = structure.quote.long.mid - structure.quote.short.mid;
    const netWorst = structure.quote.long.ask - structure.quote.short.bid;
    limitPrice = orders.roundTick(netMid + 0.25 * (netWorst - netMid));
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
      await tryEnter(symbol, bars[symbol], portfolioValue, state, newsSignals[symbol]);
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
