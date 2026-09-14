// Overnight Momentum (shares) - continuous runner. See config.js for the strategy, the
// evidence, and the caveats (most of the return is the overnight risk premium, not alpha).
//
// Two decision points a day, exactly matching the backtest:
//   09:35 ET  sell everything bought yesterday afternoon
//   15:55 ET  buy the strongest names that are up >= 1.0% from today's open
//
// Deliberately a CONTINUOUS runner rather than two scheduled scripts, unlike overnight-drift.
// That bot's twice-daily scheduled-task design is precisely what failed on 2026-08-11 and
// 08-12, when Modern Standby swallowed both of its runs and nothing noticed. A polling
// process writes a heartbeat the dashboard already watches, retries every tick if a window
// is missed, and is covered by scripts/restart-strategy-runner.ps1.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const orders = require('./orders');
const rm = require('./riskManager');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');
const HEARTBEAT_FILE = path.join(__dirname, 'logs', 'heartbeat.json');
const POLL_MS = 60 * 1000;

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

// Today's regular-session bars for the whole universe.
//
// MUST paginate. Alpaca caps a multi-symbol bar response at `limit` rows TOTAL across all
// symbols, and fills them symbol-by-symbol - so an over-limit request silently returns
// complete data for the first few symbols and NOTHING for the rest, with no error. Caught by
// test.js, which asked for 5 days across 46 symbols (~18,000 bars) and got data for 8 names.
// A single session is ~3,600 bars and fits, but "fits today" is not a guarantee: a Monday
// request reaches back over the weekend, and the universe can grow. Following next_page_token
// is the only correct way to read this endpoint.
async function getTodayBars() {
  const client = require('./alpacaClient');
  const merged = {};
  let pageToken = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: {
        symbols: cfg.UNIVERSE.join(','), timeframe: cfg.TIMEFRAME,
        start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        limit: 10000, adjustment: 'split', feed: 'iex',
        page_token: pageToken || undefined,
      },
    });
    for (const [symbol, bars] of Object.entries(res.bars || {})) {
      (merged[symbol] || (merged[symbol] = [])).push(...bars);
    }
    pageToken = res.next_page_token;
  } while (pageToken);

  const today = rm.todayET();
  const out = {};
  for (const [symbol, bars] of Object.entries(merged)) {
    out[symbol] = bars.filter((b) => {
      const d = new Date(b.t);
      if (d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== today) return false;
      const time = d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
      return time >= '09:30' && time < '16:00';
    });
  }
  return out;
}

async function reconcilePendingOrders(state) {
  for (const trade of [...state.openPositions]) {
    if (trade.status !== 'pending') continue;
    if (DRY_RUN) { trade.status = 'open'; rm.saveState(state); continue; }
    let order;
    try {
      order = await orders.getOrder(trade.orderId);
    } catch (e) {
      log('ERROR', { message: `order lookup ${trade.orderId}: ${e.message}` });
      continue;
    }
    if (order.status === 'filled') {
      trade.status = 'open';
      trade.actualEntryPrice = parseFloat(order.filled_avg_price) || trade.entryPrice;
      rm.saveState(state);
      log('ENTRY', {
        symbol: trade.symbol, qty: trade.qty,
        entryPrice: trade.actualEntryPrice, signalPrice: trade.entryPrice,
        todayReturn: trade.todayReturn,
      });
    } else if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status)) {
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { symbol: trade.symbol, orderId: trade.orderId, status: order.status });
    }
  }
}

async function closeTrade(trade, pnl, reason, state) {
  if (!DRY_RUN) await orders.closePositionMarket(trade.symbol);
  rm.recordExit(state, trade.orderId, pnl);
  log('EXIT', { symbol: trade.symbol, reason, qty: trade.qty, pnl, dryRun: DRY_RUN });
}

// Sell everything held overnight. `reason` distinguishes the normal 09:35 exit from the
// safety net that stops a position ever seeing a second night.
//
// `today` scopes this to positions entered on an EARLIER day. Without it, an exit pass that
// overlaps the 15:55 entry window would sell the position it just bought - see the long note
// at the exit gate in tick(). Defence in depth: the caller already filters, this makes the
// invariant impossible to violate from any future call site.
async function exitAll(state, positionsBySymbol, reason, today) {
  for (const trade of [...state.openPositions]) {
    if (today && trade.enteredDate && trade.enteredDate >= today) continue;
    if (trade.status === 'pending') {
      if (!DRY_RUN) {
        try { await orders.cancelOrder(trade.orderId); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
      }
      rm.removeTrade(state, trade.orderId);
      log('ENTRY_UNFILLED', { symbol: trade.symbol, orderId: trade.orderId, status: 'cancelled at exit' });
      continue;
    }
    const pos = positionsBySymbol.get(trade.symbol);
    if (!pos) {
      // Closed outside the bot. Record the last observed P&L rather than dropping it -
      // see the long note in ../../runner.js; a silent drop corrupts realizedPnL.
      const estimated = typeof trade.lastSeenPl === 'number' ? trade.lastSeenPl : 0;
      rm.recordExit(state, trade.orderId, estimated);
      log('TRADE_GONE', {
        symbol: trade.symbol, message: 'no position in account - closed outside the bot',
        pnl: estimated, pnlIsEstimate: true,
      });
      continue;
    }
    await closeTrade(trade, parseFloat(pos.unrealized_pl), reason, state);
  }

  // Safety sweep: anything in the account this bot is not tracking.
  for (const pos of positionsBySymbol.values()) {
    const qty = Math.abs(parseInt(pos.qty, 10));
    if (qty <= 0) continue;
    if (state.openPositions.some((t) => t.symbol === pos.symbol)) continue;
    if (!DRY_RUN) await orders.closePositionMarket(pos.symbol);
    log('FORCE_FLATTEN', { symbol: pos.symbol, qty, pnl: parseFloat(pos.unrealized_pl), untracked: true });
  }
}

// `candidates` must already be sorted strongest-first and TRIMMED to the open slots by the
// caller. The trimming matters: the backtest ranked by today's return, took the top N, and
// then dropped any whose price exceeded the per-trade budget - it did NOT substitute the
// next-ranked name. Letting the runner fall through to cheaper names instead would deploy
// more capital but would systematically shift the traded universe toward low-priced stocks
// (only 25 of the 46 names are affordable at a $150 budget), which is not the strategy that
// was measured. Matching the backtest exactly is the point; the unaffordable slot is simply
// not used that night.
async function tryEnter(state, portfolioValue, candidates) {
  for (const c of candidates) {
    const gate = rm.canEnterNewTrade(state, portfolioValue, c.symbol);
    if (!gate.allowed) {
      log('SIGNAL_BLOCKED', { symbol: c.symbol, reasons: gate.reasons });
      if (gate.reasons.some((r) => r.includes('max concurrent') || r.includes('paused'))) return;
      continue;
    }
    const qty = Math.floor(rm.tradeBudget(portfolioValue) / c.price);
    if (qty < 1) {
      log('UNAFFORDABLE', {
        symbol: c.symbol, price: c.price, budget: +rm.tradeBudget(portfolioValue).toFixed(2),
        reason: 'share price exceeds the per-trade budget - slot left unused, matching the backtest',
      });
      continue;
    }

    let orderId = `dry-${Date.now()}-${c.symbol}`;
    if (!DRY_RUN) {
      const placed = await orders.openMarketOrder(c.symbol, qty, 'buy');
      orderId = placed.id;
    }
    rm.recordEntry(state, {
      symbol: c.symbol,
      qty,
      entryPrice: c.price,
      actualEntryPrice: c.price,
      todayReturn: +(c.todayReturn * 100).toFixed(2),
      orderId,
      status: DRY_RUN ? 'open' : 'pending',
      enteredAt: new Date().toISOString(),
      // ET calendar date of entry. The exit logic compares DATES, not clock times, so this
      // is what guarantees the position is held overnight rather than sold seconds later.
      enteredDate: rm.todayET(),
    });
    log('ENTRY_ORDER', {
      symbol: c.symbol, qty, price: c.price,
      todayReturn: +(c.todayReturn * 100).toFixed(2), dryRun: DRY_RUN,
    });
  }
}

async function tick() {
  writeHeartbeat();
  if (!isMarketHours()) return;

  // A failed /v2/account must not abort the tick - equity is only needed to SIZE an entry,
  // and skipping the exit leg would carry positions into a second night. Same degradation
  // rule as every other runner in this project.
  let portfolioValue = null;
  try {
    const equity = parseFloat((await orders.getAccount()).equity);
    if (Number.isFinite(equity)) portfolioValue = equity;
  } catch (e) {
    log('ACCOUNT_UNAVAILABLE', { message: e.message, effect: 'exits still run, no new entries this tick' });
  }

  const state = rm.loadState();
  if (state.startEquity === null && portfolioValue !== null) {
    state.startEquity = portfolioValue;
    rm.saveState(state);
  }

  await reconcilePendingOrders(state);

  const livePositions = DRY_RUN ? [] : await orders.getAllPositions();
  const positionsBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));

  // Remember each holding's live P&L so an external close can still be booked correctly.
  for (const trade of state.openPositions) {
    const pos = positionsBySymbol.get(trade.symbol);
    if (!pos) continue;
    const pl = parseFloat(pos.unrealized_pl);
    if (Number.isFinite(pl) && trade.lastSeenPl !== pl) {
      trade.lastSeenPl = pl;
      rm.saveState(state);
    }
  }

  const t = rm.nowET();
  const today = rm.todayET();

  // A position is only ever due for exit on a LATER DAY than the one it was entered on.
  //
  // This guard is the whole correctness of the strategy, and its absence was a real bug
  // (2026-08-17..19): the gate below read `t >= cfg.EXIT_AT`, and because both sides are
  // "HH:MM" strings, '15:56' >= '09:35' is TRUE. So the tick one minute after the 15:55
  // entry satisfied the exit condition and sold everything ~1 second after the fill. All 8
  // trades this bot ever placed round-tripped instantly; it never once held overnight, which
  // is the only thing it exists to do. Comparing DATES, not clock times, is what makes the
  // holding period real - and it also removes the 403s from trying to DELETE a position
  // whose buy order had not finished settling.
  const dueForExit = state.openPositions.filter((p) => p.enteredDate && p.enteredDate < today);
  // Legacy rows written before enteredDate existed: treat as due, they predate today.
  const legacy = state.openPositions.filter((p) => !p.enteredDate);

  // --- exit leg: sell last night's positions at 09:35 -----------------------------------
  if (t >= cfg.EXIT_AT && t < cfg.ENTRY_WINDOW_START
      && (dueForExit.length > 0 || legacy.length > 0) && state.lastExitDate !== today) {
    await exitAll(state, positionsBySymbol, 'next_open', today);
    const fresh = rm.loadState();
    fresh.lastExitDate = today;
    rm.saveState(fresh);
    log('EXIT_DONE', { date: today, realizedPnL: fresh.realizedPnL });
    return;
  }

  // Safety net: a position should never see a second night. If the 09:35 exit was missed
  // (machine asleep, broker outage), force out before this session's close instead of
  // silently doubling the holding period the backtest measured. Same date rule - this must
  // never touch a position entered today.
  if (t >= cfg.EXIT_WINDOW_END && t < cfg.ENTRY_WINDOW_START
      && (dueForExit.length > 0 || legacy.length > 0)) {
    log('LATE_EXIT', { reason: `still holding at ${t} ET - the ${cfg.EXIT_AT} exit did not run`, count: dueForExit.length + legacy.length });
    await exitAll(state, positionsBySymbol, 'late_exit', today);
    const fresh = rm.loadState();
    fresh.lastExitDate = today;
    rm.saveState(fresh);
    log('EXIT_DONE', { date: today, realizedPnL: fresh.realizedPnL, late: true });
    return;
  }

  // --- entry leg: buy today's strong names at 15:55 --------------------------------------
  if (portfolioValue !== null && t >= cfg.ENTRY_WINDOW_START && t < cfg.ENTRY_WINDOW_END
      && state.lastEnterDate !== today) {
    let bars;
    try {
      bars = await getTodayBars();
    } catch (e) {
      log('ERROR', { message: `bar fetch failed: ${e.message}` });
      return; // no state change - the next tick inside the window retries
    }

    const candidates = [];
    for (const symbol of cfg.UNIVERSE) {
      const b = bars[symbol];
      if (!b || b.length < 2) continue;
      const openPrice = b[0].o;
      const price = b[b.length - 1].c;
      const todayReturn = (price - openPrice) / openPrice;
      if (todayReturn < cfg.TODAY_RETURN_THRESHOLD) continue;
      candidates.push({ symbol, price, todayReturn });
    }
    // Strongest first, then trimmed to the free slots - the exact order the backtest's
    // concurrency cap applied (rank, slice, then affordability).
    candidates.sort((a, b) => b.todayReturn - a.todayReturn);
    const freeSlots = Math.max(0, cfg.MAX_CONCURRENT_POSITIONS - state.openPositions.length);

    await tryEnter(state, portfolioValue, candidates.slice(0, freeSlots));
    const fresh = rm.loadState();
    fresh.lastEnterDate = today;
    rm.saveState(fresh);
    log('ENTER_DONE', {
      date: today, scanned: cfg.UNIVERSE.length,
      qualified: candidates.length, openPositions: fresh.openPositions.length,
    });
  }
}

async function main() {
  log('START', {
    dryRun: DRY_RUN, strategy: 'OvernightMomentum',
    universeSize: cfg.UNIVERSE.length, threshold: cfg.TODAY_RETURN_THRESHOLD,
  });
  // setInterval fires on a fixed clock regardless of whether the previous tick finished. A
  // trade is only written to state AFTER its order is placed, so overlapping ticks inside
  // the 4-minute entry window could double-enter the same symbol. Skip instead of stacking.
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

main();
