// Tests for the 2026-08-13 fixes. Pure logic + a live read-only connectivity check per
// account. Run: node --env-file=.env --env-file=strategies/overnight-drift/.env.overnight
//   --env-file=strategies/credit-spread/.env.creditspread
//   --env-file=strategies/overnight-momentum/.env.overnightmomentum scripts/test-fixes-2026-08-13.js
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

// --- 1. credit-spread: mleg net-credit sign ---------------------------------------------
// Reproduces the exact live data from 2026-08-13 (QQQ 719/716P): the entry order was
// submitted with limit_price 0.13 and Alpaca reported filled_avg_price -0.13. The old code
// stored that raw, so entryCreditTotal was -13 and the profit-target test `pl >= -6.50`
// was true the moment the spread opened.
console.log('\n[1] credit-spread net-credit sign normalisation');
function normaliseCredit(filledAvgPrice, fallback) {
  const filledNet = Math.abs(parseFloat(filledAvgPrice));
  return Number.isFinite(filledNet) && filledNet > 0 ? filledNet : fallback;
}
const PROFIT_TARGET_PCT = 0.50, STOP_MULTIPLE = 2.0;
function exitReason(credit, pl, qty = 1) {
  const entryCreditTotal = credit * 100 * qty;
  if (!(entryCreditTotal > 0)) return 'skipped_bad_credit';
  if (pl >= entryCreditTotal * PROFIT_TARGET_PCT) return 'profit_target';
  if (pl <= -entryCreditTotal * (STOP_MULTIPLE - 1)) return 'stop';
  return 'hold';
}
// The shipped code exactly as it was BEFORE this fix - no sign normalisation, no guard.
// Kept so the regression is demonstrated rather than asserted.
function exitReasonOld(rawFilledAvgPrice, pl, qty = 1) {
  const entryCreditTotal = parseFloat(rawFilledAvgPrice) * 100 * qty;
  if (pl >= entryCreditTotal * PROFIT_TARGET_PCT) return 'profit_target';
  if (pl <= -entryCreditTotal * (STOP_MULTIPLE - 1)) return 'stop';
  return 'hold';
}
check('negative mleg fill becomes a positive credit', normaliseCredit('-0.13', 0.13) === 0.13);
check('positive mleg fill stays positive', normaliseCredit('0.34', 0.31) === 0.34);
check('unparseable fill falls back to the limit credit', normaliseCredit('', 0.19) === 0.19);
check('zero fill falls back to the limit credit', normaliseCredit('0', 0.19) === 0.19);

// The actual live regression: 8/13 filled at 0.13 credit, unrealised P&L right after the
// fill was -2 (the bid-ask spread). Old behaviour closed it instantly.
check('OLD behaviour reproduces the bug (regression witness)',
  exitReasonOld('-0.13', -2) === 'profit_target', `got ${exitReasonOld('-0.13', -2)}`);
// ...and the inversion hit the stop test too: with a negative credit BOTH tests were true
// at once, which is why "profit_target" (checked first) always won.
check('OLD behaviour: the stop test was inverted as well',
  exitReasonOld('-0.13', 5) === 'profit_target' && (5 <= 0.13 * 100), 'both tests were satisfiable');
check('FIXED: a just-opened spread at -$2 is held', exitReason(0.13, -2) === 'hold', `got ${exitReason(0.13, -2)}`);
check('FIXED: profit target fires at +50% of credit', exitReason(0.13, 6.5) === 'profit_target');
check('FIXED: just under target still holds', exitReason(0.13, 6.4) === 'hold');
check('FIXED: stop fires when the loss reaches 1x credit', exitReason(0.13, -13) === 'stop');
check('FIXED: just above stop still holds', exitReason(0.13, -12.9) === 'hold');
check('guard: non-positive credit skips both exit tests', exitReason(0, -2) === 'skipped_bad_credit');
// All three historical trades would now be held rather than instantly round-tripped.
for (const [d, c] of [['2026-08-06', 0.34], ['2026-08-11', 0.17], ['2026-08-13', 0.13]]) {
  check(`historical ${d} (credit $${c}) is held at open, not closed`, exitReason(c, -2) === 'hold');
}

// --- 2. shared transport: retry policy --------------------------------------------------
console.log('\n[2] lib/httpClient.js retry policy');
const { createAlpacaClient } = require('../lib/httpClient');
const fakeCfg = { headers: { 'APCA-API-KEY-ID': 'k' }, TRADING_BASE: 'https://x.invalid', DATA_BASE: 'https://y.invalid' };
check('factory rejects a config missing bases', (() => {
  try { createAlpacaClient({ headers: {} }); return false; } catch { return true; }
})());
check('factory accepts a complete config', !!createAlpacaClient(fakeCfg).trading);

const realFetch = global.fetch;
async function withFetch(impl, fn) { global.fetch = impl; try { return await fn(); } finally { global.fetch = realFetch; } }
function abortErr() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

(async () => {
  // A GET that times out once then succeeds must recover (the 2026-08-13 swing failure mode).
  let calls = 0;
  await withFetch(async () => { calls++; if (calls === 1) throw abortErr(); return { status: 200, ok: true, text: async () => '{"equity":"1000"}' }; },
    async () => {
      const c = createAlpacaClient(fakeCfg);
      const r = await c.trading('/v2/account');
      check('GET timeout is retried once and recovers', calls === 2 && r.equity === '1000', `calls=${calls}`);
    });

  // A GET that keeps timing out gives up after exactly 2 attempts (bounded, ~40s worst case).
  calls = 0;
  await withFetch(async () => { calls++; throw abortErr(); }, async () => {
    const c = createAlpacaClient(fakeCfg);
    try { await c.trading('/v2/account'); check('bounded timeout retry throws', false); }
    catch (e) { check('GET timeout gives up after 2 attempts', calls === 2 && /timed out/.test(e.message), `calls=${calls} msg=${e.message}`); }
  });

  // A POST that times out must NOT be retried - it may already have placed a live order.
  calls = 0;
  await withFetch(async () => { calls++; throw abortErr(); }, async () => {
    const c = createAlpacaClient(fakeCfg);
    try { await c.trading('/v2/orders', { method: 'POST', body: {} }); check('POST timeout throws', false); }
    catch (e) { check('POST timeout is NOT retried (no double-placed orders)', calls === 1, `calls=${calls}`); }
  });

  // Network errors still surface e.cause rather than a bare "fetch failed".
  calls = 0;
  await withFetch(async () => { calls++; const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }, async () => {
    const c = createAlpacaClient(fakeCfg);
    try { await c.trading('/v2/account'); check('network error throws', false); }
    catch (e) { check('network error retries 3x and reports the cause', calls === 3 && /ENOTFOUND/.test(e.message), `calls=${calls} msg=${e.message}`); }
  });

  // 5xx retried on GET, not on POST.
  calls = 0;
  await withFetch(async () => { calls++; return calls < 3 ? { status: 503, ok: false, text: async () => '<html>' } : { status: 200, ok: true, text: async () => '{"ok":1}' }; },
    async () => {
      const c = createAlpacaClient(fakeCfg);
      const r = await c.trading('/v2/account');
      check('GET 503 backs off and recovers', calls === 3 && r.ok === 1, `calls=${calls}`);
    });
  calls = 0;
  await withFetch(async () => { calls++; return { status: 503, ok: false, text: async () => '<html>' }; }, async () => {
    const c = createAlpacaClient(fakeCfg);
    try { await c.trading('/v2/orders', { method: 'POST', body: {} }); check('POST 503 throws', false); }
    catch (e) { check('POST 503 is NOT retried', calls === 1 && e.status === 503, `calls=${calls}`); }
  });

  // --- 3. externally-closed trades must still reach realizedPnL -------------------------
  // Mirrors the TRADE_GONE branch in every runner. Uses a stand-in state store rather than
  // lib/riskManager directly, because that writes to the LIVE logs/daily-state.json.
  console.log('\n[3] TRADE_GONE records P&L (daily-loss circuit breaker)');
  function makeRm() {
    const state = { realizedPnL: 0, openTrades: [], startEquity: 1000 };
    return {
      state,
      removeTrade: (id) => { state.openTrades = state.openTrades.filter((t) => t.orderId !== id); },
      recordExit(id, pnl) { state.realizedPnL += pnl; this.removeTrade(id); },
    };
  }
  // OLD behaviour: bare removeTrade, P&L silently discarded.
  let rmOld = makeRm();
  rmOld.state.openTrades.push({ orderId: 'a', lastSeenPl: -260 });
  rmOld.removeTrade('a');
  check('OLD: externally-closed loss left realizedPnL at 0 (regression witness)', rmOld.state.realizedPnL === 0);

  // NEW behaviour: recordExit with the last observed P&L.
  let rmNew = makeRm();
  rmNew.state.openTrades.push({ orderId: 'a', lastSeenPl: -260 });
  const est = typeof rmNew.state.openTrades[0].lastSeenPl === 'number' ? rmNew.state.openTrades[0].lastSeenPl : 0;
  rmNew.recordExit('a', est);
  check('FIXED: externally-closed loss reaches realizedPnL', rmNew.state.realizedPnL === -260);
  check('FIXED: trade is still removed from openTrades', rmNew.state.openTrades.length === 0);

  // The consequence that actually matters: the circuit breaker now trips.
  const DAILY_LOSS_STOP_PCT = 0.25;
  const tripped = (s) => !!(s.startEquity && s.realizedPnL <= -s.startEquity * DAILY_LOSS_STOP_PCT);
  check('OLD: daily loss stop did NOT trip after a -$260 external close', !tripped(rmOld.state));
  check('FIXED: daily loss stop trips after a -$260 external close', tripped(rmNew.state));

  // No lastSeenPl recorded yet (closed before the first management tick) -> counted as 0,
  // which is the old behaviour, so the fix can never be worse than what it replaces.
  let rmNoData = makeRm();
  rmNoData.state.openTrades.push({ orderId: 'a' });
  const est2 = typeof rmNoData.state.openTrades[0].lastSeenPl === 'number' ? rmNoData.state.openTrades[0].lastSeenPl : 0;
  rmNoData.recordExit('a', est2);
  check('no observation available degrades to 0, never NaN', rmNoData.state.realizedPnL === 0);

  // --- 3b. the new overnight-drift staleness alert actually fires -----------------------
  // An alert that never fires is worse than no alert, so both directions are asserted.
  console.log('\n[3b] overnight-drift staleness alert');
  const { checkOvernightStale, prevWeekdayET } = require('../lib/healthChecks');
  const WED = { nowET: '17:00', today: '2026-08-13', weekday: 'Thu', prevDay: '2026-08-12' };
  const healthy = { lastEnterDate: '2026-08-13', lastExitDate: '2026-08-13', openPositions: [] };
  check('healthy same-day state raises nothing', checkOvernightStale(healthy, WED) === null);
  check('missed enter run after 16:05 is flagged',
    !!checkOvernightStale({ ...healthy, lastEnterDate: '2026-08-11' }, WED));
  check('the 2026-08-12 skipped session would have been caught',
    !!checkOvernightStale({ lastEnterDate: '2026-08-07', lastExitDate: '2026-08-10', openPositions: [] },
      { nowET: '10:00', today: '2026-08-12', weekday: 'Wed', prevDay: '2026-08-11' }));
  check('missed exit run with positions still open is flagged',
    !!checkOvernightStale({ lastEnterDate: '2026-08-13', lastExitDate: '2026-08-12', openPositions: [{}] },
      { nowET: '10:00', today: '2026-08-13', weekday: 'Thu', prevDay: '2026-08-12' }));
  check('no false positive before the 15:55 enter window',
    checkOvernightStale({ lastEnterDate: '2026-08-12', lastExitDate: '2026-08-13', openPositions: [] },
      { nowET: '11:00', today: '2026-08-13', weekday: 'Thu', prevDay: '2026-08-12' }) === null);
  check('weekends raise nothing', checkOvernightStale({ lastEnterDate: '2026-08-07' },
    { nowET: '17:00', today: '2026-08-15', weekday: 'Sat', prevDay: '2026-08-14' }) === null);
  check('missing state raises nothing', checkOvernightStale(null, WED) === null);
  check('prevWeekdayET skips the weekend', prevWeekdayET(new Date('2026-08-10T18:00:00Z')) === '2026-08-07',
    `got ${prevWeekdayET(new Date('2026-08-10T18:00:00Z'))}`);

  // --- 3c. missed-flatten alert ---------------------------------------------------------
  // The failure this exists for: 2026-08-14, machine asleep from 15:27, the 15:45 flatten
  // never ran, and a 0DTE credit spread would have been stranded into expiry. Both
  // directions asserted - a detector that cannot fire is as useless as one that always does.
  console.log('\n[3c] missed-flatten alert');
  const { shouldFlagMissedFlatten, overdueAfter } = require('../lib/healthChecks');
  const base = { weekday: 'Fri', today: '2026-08-14', flattenAt: '15:45', isHoliday: false };
  check('grace period is flatten + 20min', overdueAfter('15:45') === '16:05', `got ${overdueAfter('15:45')}`);
  check('handles an hour rollover', overdueAfter('15:50') === '16:10', `got ${overdueAfter('15:50')}`);
  check('FIRES when overdue and no DAY_END',
    shouldFlagMissedFlatten({ ...base, nowET: '16:10', ranToday: false }) === true);
  check('silent once DAY_END is logged',
    shouldFlagMissedFlatten({ ...base, nowET: '16:10', ranToday: true }) === false);
  check('silent before the grace period expires',
    shouldFlagMissedFlatten({ ...base, nowET: '15:50', ranToday: false }) === false);
  check('silent at the exact flatten minute',
    shouldFlagMissedFlatten({ ...base, nowET: '15:45', ranToday: false }) === false);
  check('silent on weekends',
    shouldFlagMissedFlatten({ ...base, weekday: 'Sat', nowET: '16:10', ranToday: false }) === false);
  check('silent on market holidays',
    shouldFlagMissedFlatten({ ...base, isHoliday: true, nowET: '16:10', ranToday: false }) === false);
  check('still fires late in the evening',
    shouldFlagMissedFlatten({ ...base, nowET: '23:00', ranToday: false }) === true);

  // --- 4. live per-account connectivity: each client must reach its OWN account ----------
  console.log('\n[4] live account isolation (read-only)');
  const clients = [
    ['ORB-15         ', require('../lib/alpacaClient')],
    ['credit-spread  ', require('../strategies/credit-spread/alpacaClient')],
    // swing-signals retired 2026-08-14; overnight-momentum runs on that account now.
    ['overnight-mom  ', require('../strategies/overnight-momentum/alpacaClient')],
    ['overnight-drift', require('../strategies/overnight-drift/alpacaClient')],
  ];
  const seen = new Map();
  for (const [name, c] of clients) {
    try {
      const a = await c.trading('/v2/account');
      seen.set(name.trim(), a.account_number);
      console.log(`  PASS  ${name} -> acct ${a.account_number} equity $${a.equity}`);
      pass++;
    } catch (e) { console.log(`  FAIL  ${name} -> ${e.message}`); fail++; }
  }
  check('all four clients hit four DISTINCT accounts', new Set(seen.values()).size === 4,
    `saw ${new Set(seen.values()).size}: ${[...seen.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
