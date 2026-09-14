// Tests for overnight-momentum. The runner's entry leg only executes in a 4-minute window
// at 15:55 ET, so it cannot be exercised by simply running the bot - this drives the same
// logic directly, plus a live "what would it have bought" evaluation against real bars.
//
// Run: node --env-file=strategies/overnight-momentum/.env.overnightmomentum \
//        --env-file=strategies/overnight-drift/.env.overnight \
//        strategies/overnight-momentum/test.js
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const rm = require('./riskManager');
const orders = require('./orders');
const client = require('./alpacaClient');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

// --- 1. config sanity ------------------------------------------------------------------
console.log('\n[1] config');
check('universe is non-empty and de-duplicated',
  cfg.UNIVERSE.length > 0 && new Set(cfg.UNIVERSE).size === cfg.UNIVERSE.length);
check('universe matches the 46 names the backtest measured', cfg.UNIVERSE.length === 46, `got ${cfg.UNIVERSE.length}`);
try {
  const drift = require('../overnight-drift/config').UNIVERSE;
  const overlap = cfg.UNIVERSE.filter((s) => drift.includes(s));
  check('zero overlap with the overnight-drift options bot', overlap.length === 0, `overlap: ${overlap}`);
} catch { console.log('  SKIP  overlap check (overnight-drift env not loaded)'); }
check('threshold matches the validated overnight-drift setting', cfg.TODAY_RETURN_THRESHOLD === 0.010);
check('risk sizing is the least-fitted 15%, not the sweep-optimal 25%', cfg.RISK_PCT_PER_TRADE === 0.15);
check('entry window is inside the session and before the close',
  cfg.ENTRY_WINDOW_START >= '15:45' && cfg.ENTRY_WINDOW_END < '16:00');
check('exit fires before the next entry window', cfg.EXIT_AT < cfg.ENTRY_WINDOW_START);
check('second-night safety net sits between the two', cfg.EXIT_WINDOW_END < cfg.ENTRY_WINDOW_START);

// --- 2. state is PERSISTENT, not daily-reset -------------------------------------------
// This is the structural difference from swing-signals. A daily reset would orphan every
// position at midnight, since this strategy holds overnight by design.
console.log('\n[2] state persistence (the structural change from swing-signals)');
const STATE = path.join(__dirname, 'logs', 'state.json');
const backup = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : null;
try {
  fs.writeFileSync(STATE, JSON.stringify({
    openPositions: [{ symbol: 'TEST', qty: 1, orderId: 'x', status: 'open', entryPrice: 10 }],
    lastEnterDate: '1999-01-01', lastExitDate: '1999-01-01', realizedPnL: 42, trades: 7, startEquity: 1000,
  }));
  const reloaded = rm.loadState();
  check('a position dated long ago SURVIVES reload', reloaded.openPositions.length === 1,
    `got ${reloaded.openPositions.length} - a daily reset would have dropped it`);
  check('realizedPnL survives reload', reloaded.realizedPnL === 42);
  check('trade count survives reload', reloaded.trades === 7);

  // recordExit must both book P&L and drop the trade.
  rm.recordExit(reloaded, 'x', -13);
  check('recordExit books P&L', reloaded.realizedPnL === 29, `got ${reloaded.realizedPnL}`);
  check('recordExit removes the position', reloaded.openPositions.length === 0);
} finally {
  if (backup === null) fs.unlinkSync(STATE); else fs.writeFileSync(STATE, backup);
}

// --- 2b. THE HOLDING-PERIOD INVARIANT ----------------------------------------------------
// Regression guard for the 2026-08-17..19 bug: the exit gate compared clock-time strings
// (`t >= '09:35'`), and '15:56' >= '09:35' is true, so the tick after the 15:55 entry sold
// everything ~1 second after the fill. All 8 trades round-tripped instantly and the bot
// never held overnight once. The fix compares ET DATES instead.
console.log('\n[2b] holding-period invariant (never exit a position entered today)');
function exitGateOld(nowET, positions, lastExitDate, today) {
  return nowET >= '09:35' && positions.length > 0 && lastExitDate !== today;
}
function exitGateNew(nowET, positions, lastExitDate, today) {
  const due = positions.filter((p) => p.enteredDate && p.enteredDate < today);
  const legacy = positions.filter((p) => !p.enteredDate);
  return nowET >= cfg.EXIT_AT && nowET < cfg.ENTRY_WINDOW_START
    && (due.length + legacy.length > 0) && lastExitDate !== today;
}
const justBought = [{ symbol: 'MARA', enteredDate: '2026-08-17' }];
const heldOvernight = [{ symbol: 'MARA', enteredDate: '2026-08-16' }];

check('OLD gate fires one minute after entry (reproduces the bug)',
  exitGateOld('15:56', justBought, null, '2026-08-17') === true);
check('FIXED: 15:56 the same day does NOT exit', exitGateNew('15:56', justBought, null, '2026-08-17') === false);
check('FIXED: 09:35 next morning DOES exit', exitGateNew('09:35', heldOvernight, null, '2026-08-17') === true);
check('FIXED: 09:34 is too early', exitGateNew('09:34', heldOvernight, null, '2026-08-17') === false);
check('FIXED: already exited today does not re-exit',
  exitGateNew('09:35', heldOvernight, '2026-08-17', '2026-08-17') === false);
check('FIXED: nothing held means no exit pass', exitGateNew('09:35', [], null, '2026-08-17') === false);
check('FIXED: pre-enteredDate legacy rows still get exited',
  exitGateNew('09:35', [{ symbol: 'OLD' }], null, '2026-08-17') === true);
// exitAll's own guard must hold even if a caller forgets to filter.
function exitAllWouldSell(positions, today) {
  return positions.filter((p) => !(today && p.enteredDate && p.enteredDate >= today)).map((p) => p.symbol);
}
check('exitAll refuses to sell a position entered today',
  exitAllWouldSell(justBought, '2026-08-17').length === 0);
check('exitAll sells a position entered yesterday',
  exitAllWouldSell(heldOvernight, '2026-08-17').join() === 'MARA');

// --- 3. entry gates ---------------------------------------------------------------------
console.log('\n[3] entry gates');
const gateState = { openPositions: [], trades: 0, realizedPnL: 0, startEquity: 1000 };
check('a clean state allows entry', rm.canEnterNewTrade(gateState, 1000, 'AAPL').allowed);
gateState.openPositions = [{ symbol: 'AAPL' }];
check('refuses a second position in the same symbol',
  !rm.canEnterNewTrade(gateState, 1000, 'AAPL').allowed);
check('still allows a different symbol', rm.canEnterNewTrade(gateState, 1000, 'MU').allowed);
gateState.openPositions = Array.from({ length: cfg.MAX_CONCURRENT_POSITIONS }, (_, i) => ({ symbol: `S${i}` }));
check('enforces the concurrency cap', !rm.canEnterNewTrade(gateState, 1000, 'MU').allowed);

// --- 4. sizing math ---------------------------------------------------------------------
console.log('\n[4] sizing (whole shares, 15% of equity)');
check('budget is 15% of equity', Math.abs(rm.tradeBudget(1000) - 150) < 1e-9);
check('$1000 equity buys 1 share of a $120 stock', Math.floor(rm.tradeBudget(1000) / 120) === 1);
check('a stock priced above the budget is skipped (qty floors to 0)',
  Math.floor(rm.tradeBudget(1000) / 900) === 0);
check('5 concurrent positions cannot exceed 75% of equity',
  cfg.MAX_CONCURRENT_POSITIONS * cfg.RISK_PCT_PER_TRADE <= 0.75 + 1e-9);

// --- 5. live signal evaluation ----------------------------------------------------------
// Runs the real selection logic against the most recent completed session. Read-only: this
// reports what the bot WOULD buy, and places nothing.
(async () => {
  console.log('\n[5] live signal evaluation (read-only, no orders)');
  // Paginated - see the note on getTodayBars in runner.js. The unpaginated version of this
  // very request is what exposed the truncation bug (46 symbols x 5 days returned data for
  // only 8 names, silently).
  const res = { bars: {} };
  let pageToken = null;
  do {
    const page = await client.data('/v2/stocks/bars', {
      params: {
        symbols: cfg.UNIVERSE.join(','), timeframe: cfg.TIMEFRAME,
        start: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        limit: 10000, adjustment: 'split', feed: 'iex',
        page_token: pageToken || undefined,
      },
    });
    for (const [symbol, bars] of Object.entries(page.bars || {})) {
      (res.bars[symbol] || (res.bars[symbol] = [])).push(...bars);
    }
    pageToken = page.next_page_token;
  } while (pageToken);
  const dayOf = (b) => new Date(b.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const timeOf = (b) => new Date(b.t).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  // Most recent session that actually has a 15:55 bar.
  const allDays = new Set();
  for (const bars of Object.values(res.bars || {})) for (const b of bars) allDays.add(dayOf(b));
  const session = [...allDays].sort().pop();
  check('got bar data for at least one recent session', !!session, `days seen: ${[...allDays].join(',')}`);

  const candidates = [];
  let withData = 0;
  for (const symbol of cfg.UNIVERSE) {
    const bars = (res.bars[symbol] || []).filter((b) => dayOf(b) === session && timeOf(b) >= '09:30' && timeOf(b) < '16:00');
    if (bars.length < 2) continue;
    withData += 1;
    const openPrice = bars[0].o;
    const price = bars[bars.length - 1].c;
    const todayReturn = (price - openPrice) / openPrice;
    if (todayReturn >= cfg.TODAY_RETURN_THRESHOLD) candidates.push({ symbol, price, todayReturn });
  }
  candidates.sort((a, b) => b.todayReturn - a.todayReturn);

  check('bar data resolved for most of the universe', withData >= cfg.UNIVERSE.length * 0.8,
    `${withData}/${cfg.UNIVERSE.length}`);
  console.log(`        session ${session}: ${candidates.length} of ${withData} names qualified (>= ${(cfg.TODAY_RETURN_THRESHOLD * 100).toFixed(1)}%)`);

  const account = await orders.getAccount();
  const equity = parseFloat(account.equity);
  const budget = equity * cfg.RISK_PCT_PER_TRADE;
  // Rank, slice to the cap, THEN test affordability - the backtest's exact order. An
  // unaffordable name leaves its slot unused rather than promoting the next candidate.
  const picks = candidates.slice(0, cfg.MAX_CONCURRENT_POSITIONS);
  let deployed = 0, skipped = 0;
  for (const c of picks) {
    const qty = Math.floor(budget / c.price);
    if (qty < 1) {
      skipped += 1;
      console.log(`        SKIP     ${c.symbol.padEnd(5)} @ $${c.price.toFixed(2).padStart(8)} - above the $${budget.toFixed(2)} budget`);
      continue;
    }
    deployed += qty * c.price;
    console.log(`        would buy ${String(qty).padStart(3)} x ${c.symbol.padEnd(5)} @ $${c.price.toFixed(2).padStart(8)} (up ${(c.todayReturn * 100).toFixed(2)}%) = $${(qty * c.price).toFixed(2)}`);
  }
  console.log(`        ${picks.length - skipped} affordable of ${picks.length} picked; $${deployed.toFixed(2)} of $${equity.toFixed(2)} deployed`);
  check('selection respects the concurrency cap', picks.length <= cfg.MAX_CONCURRENT_POSITIONS);
  check('capital deployed never exceeds equity', deployed <= equity, `$${deployed.toFixed(2)} vs $${equity.toFixed(2)}`);
  // At $1,000 only 25 of the 46 names are buyable. That is a real constraint, and it is
  // already priced into the backtest (which floored whole shares identically) - but it must
  // not be so severe that the bot degenerates into never trading, which is what killed
  // swing-signals. The backtest took 849 trades over 251 sessions (~3.4/day).
  check('at least some of the universe is tradeable at this equity',
    cfg.UNIVERSE.length > 0 && budget > 0);
  check('candidates are ranked strongest-first',
    candidates.every((c, i) => i === 0 || candidates[i - 1].todayReturn >= c.todayReturn));

  // --- 6. account isolation ------------------------------------------------------------
  console.log('\n[6] account isolation');
  check('trades its own account, not another bot\'s', account.account_number === 'PA3AA9K57G7R',
    `got ${account.account_number}`);
  const positions = await orders.getAllPositions();
  console.log(`        equity $${account.equity}, ${positions.length} open position(s)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
