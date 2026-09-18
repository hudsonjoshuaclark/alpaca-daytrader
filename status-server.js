// Live status dashboard for the ORB bot + its automation stack.
// Serves status.html at / and aggregated live state at /api/status:
// runner health, account, positions, today's activity, watchdog, scheduled tasks,
// latest nightly review, and equity history.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./lib/config');
const orders = require('./lib/orders');
const rm = require('./lib/riskManager');
const md = require('./lib/marketData');
const ovOrders = require('./strategies/overnight-drift/orders');
const csOrders = require('./strategies/credit-spread/orders');
const csCfg = require('./strategies/credit-spread/config');
const omOrders = require('./strategies/overnight-momentum/orders');
const omCfg = require('./strategies/overnight-momentum/config');
const health = require('./lib/healthChecks');
const { parseOcc, buildPositionGroups } = require('./lib/positions');
const yahoo = require('./lib/yahooFinance');
const finnhub = require('./lib/finnhub');

const PORT = 4321;
const LOGS = path.join(__dirname, 'logs');
const OV_DIR = path.join(__dirname, 'strategies', 'overnight-drift');
const OV_LOGS = path.join(OV_DIR, 'logs');
const CS_DIR = path.join(__dirname, 'strategies', 'credit-spread');
const CS_LOGS = path.join(CS_DIR, 'logs');
const OM_DIR = path.join(__dirname, 'strategies', 'overnight-momentum');
const OM_LOGS = path.join(OM_DIR, 'logs');

// Dashboard is tunneled to a public URL, so it needs auth. Required once DASHBOARD_USER/
// DASHBOARD_PASS are set in .env; if unset, falls back to localhost-only (no auth) so the
// server still works pre-tunnel setup.
const DASHBOARD_USER = process.env.DASHBOARD_USER || null;
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || null;
const AUTH_ENABLED = !!(DASHBOARD_USER && DASHBOARD_PASS);

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return timingSafeStrEqual(user, DASHBOARD_USER) && timingSafeStrEqual(pass, DASHBOARD_PASS);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Registry of every bot the dashboard can act on. Each has its OWN Alpaca account/keys
// (its own orders module) and its own log dir, so a manual close has to be routed to the
// right one — closing by symbol alone is ambiguous across bots.
const STRATEGIES = {
  'orb15': {
    name: 'ORB-15',
    orders,
    logs: LOGS,
    // Tracked trades, normalised to { symbols, closeSpread } — `symbols` is every leg of
    // one structure, `closeSpread` closes it as a unit the way the bot's exit path does.
    // closeSpread stays null for single-leg trades: an mleg order needs two legs, and a
    // lone long call closes fine as a plain position.
    trades: () => {
      const s = readJson(path.join(LOGS, 'daily-state.json'));
      if (!s || s.date !== todayET()) return [];
      return (s.openTrades || []).filter((t) => Array.isArray(t.legs) && t.legs.length).map((t) => ({
        symbols: t.legs.map((l) => l.symbol),
        closeSpread: t.legs.length > 1 ? () => orders.closeSpreadMarket(t.legs, t.qty) : null,
      }));
    },
  },
  'overnight': {
    name: 'Overnight Drift',
    orders: ovOrders,
    logs: OV_LOGS,
    trades: () => {
      const s = readJson(path.join(OV_LOGS, 'state.json'));
      return ((s && s.openPositions) || []).filter((t) => Array.isArray(t.legs) && t.legs.length).map((t) => ({
        symbols: t.legs.map((l) => l.symbol),
        closeSpread: t.legs.length > 1 ? () => ovOrders.closeSpreadMarket(t.legs, t.qty) : null,
      }));
    },
  },
  'credit-spread': {
    name: 'Credit Spread (0DTE)',
    orders: csOrders,
    logs: CS_LOGS,
    trades: () => {
      const s = readJson(path.join(CS_LOGS, 'daily-state.json'));
      if (!s || s.date !== todayET()) return [];
      return (s.openTrades || []).filter((t) => t.shortLeg && t.longLeg).map((t) => ({
        symbols: [t.shortLeg.symbol, t.longLeg.symbol],
        closeSpread: () => csOrders.closeCreditSpreadMarket([t.shortLeg, t.longLeg], t.qty),
      }));
    },
  },
  'overnight-momentum': {
    name: 'Overnight Momentum',
    orders: omOrders,
    logs: OM_LOGS,
    trades: () => [], // plain stock shares, never multi-leg
  },
};

// Which symbols get closed together if you close `symbol`. Several bots hold multi-leg
// option structures, and closing one leg on its own can leave a NAKED SHORT (e.g. buying
// back nothing but the protective long of a credit spread) — so a click on any leg has to
// take the whole structure with it. Untracked/orphan legs fall back to just themselves,
// which is what you'd want when manually cleaning one up.
function closeGroupFor(key, symbol) {
  const strat = STRATEGIES[key];
  if (!strat) return null;
  const match = strat.trades().find((t) => t.symbols.includes(symbol));
  return match || { symbols: [symbol], closeSpread: null };
}

function annotateCloseGroups(key, positions) {
  return (positions || []).map((p) => ({ ...p, closesWith: closeGroupFor(key, p.symbol).symbols }));
}

function tailLines(file, n) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
}

function isMarketHours() {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return false;
  const t = rm.nowET();
  return t >= '09:30' && t < '16:00';
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Surfaces the 2026-07-29 laptop-sleep incident's failure mode automatically instead of
// requiring a human to notice and ask: the runner missed its entire ORB entry window
// (09:45-11:30 ET) that day because Modern Standby didn't wake the machine until 12:21pm.
// Finds today's FIRST 'START' event (the runner logs one every time it (re)launches) and
// flags it if that first start happened at/after the entry cutoff, or hasn't happened at
// all yet on a weekday past the cutoff.
// Generalised over the three continuous runners. It was ORB-15-only, which meant the
// 2026-08-12 outage (Modern Standby swallowed the whole session - none of the four bots
// ran, no START event in any log) was visible on exactly one of four dashboard cards.
// Each bot passes its own log and its own entry cutoff.
function checkMissedEntryWindow(logFile, entryCutoff, label = 'Runner') {
  const today = todayET();
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return null;

  const startTimes = tailLines(logFile, 500)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.event === 'START' && e.ts
      && new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today);
  const nowET = rm.nowET();

  if (startTimes.length === 0) {
    if (nowET >= entryCutoff) {
      return { missed: true, reason: `${label}: no start logged yet today, and it's already past the ${entryCutoff} ET entry cutoff — check whether the machine was asleep.` };
    }
    return null;
  }

  const firstStart = startTimes[0];
  const firstStartTimeET = new Date(firstStart.ts).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  if (firstStartTimeET >= entryCutoff) {
    return { missed: true, reason: `${label}: first start today was ${firstStartTimeET} ET, after the ${entryCutoff} ET entry cutoff — likely missed the whole entry window (e.g. the machine was asleep).` };
  }
  return null;
}

// Pure predicates live in lib/healthChecks.js so they are testable without starting this
// server; this wrapper supplies the clock.
function checkOvernightStale(state) {
  return health.checkOvernightStale(state, {
    nowET: rm.nowET(),
    today: todayET(),
    weekday: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }),
    prevDay: health.prevWeekdayET(),
  });
}

// Shared liveness read for any bot that writes logs/heartbeat.json. Same 120s threshold
// buildStatus already uses for ORB-15: every continuous runner heartbeats on each tick,
// off-hours included, so a stale file means the process is gone, not that it is quiet.
function heartbeatHealth(logsDir) {
  const heartbeat = readJson(path.join(logsDir, 'heartbeat.json'));
  const heartbeatAgeSec = heartbeat ? Math.round((Date.now() - new Date(heartbeat.ts).getTime()) / 1000) : null;
  return { alive: heartbeatAgeSec !== null && heartbeatAgeSec < 120, heartbeatAgeSec };
}

// ---------------------------------------------------------------------------------------
// Overview: the "did anything happen today, and am I up or down" layer.
//
// Built around one rule learned the hard way: a quiet market and a dead bot must never look
// alike. Those are two independent axes and they are reported separately -
//   marketSession()  - is a session even running right now?
//   health rollup    - are the processes that would act actually alive?
// so "no trades" can be rendered as reassuring or alarming based on which axis is at fault,
// rather than the reader having to infer it.

const US_HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);

// All times America/New_York, DST included, because that is what the bots trade on.
function marketSession(now = new Date()) {
  const weekday = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const date = todayET();
  const t = rm.nowET();
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const isHoliday = US_HOLIDAYS_2026.has(date);

  let state, label;
  if (isWeekend) { state = 'weekend'; label = 'Weekend — markets closed'; }
  else if (isHoliday) { state = 'holiday'; label = 'Market holiday — markets closed'; }
  else if (t < '04:00') { state = 'closed'; label = 'Overnight — markets closed'; }
  else if (t < '09:30') { state = 'premarket'; label = `Pre-market — opens 09:30 ET`; }
  else if (t < '16:00') { state = 'open'; label = 'Market open'; }
  else if (t < '20:00') { state = 'afterhours'; label = 'After hours — regular session closed'; }
  else { state = 'closed'; label = 'Overnight — markets closed'; }

  // Next regular open, skipping weekends and holidays.
  const next = new Date(now.getTime());
  if (state === 'open' || state === 'premarket') {
    // today
  } else {
    do { next.setDate(next.getDate() + 1); }
    while (['Sat', 'Sun'].includes(next.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }))
      || US_HOLIDAYS_2026.has(next.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })));
  }
  const nextDay = next.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  return {
    state,
    label,
    isTradingSession: state === 'open',
    // "today counts" only mean something on a day the market actually runs
    isTradingDay: !isWeekend && !isHoliday,
    nextOpen: (state === 'open') ? null : `${nextDay} 09:30 ET`,
  };
}

// Events that represent an actual MOVE - an order placed, filled, or closed. Deliberately
// excludes RATCHET / TICK_SKIPPED / NO_SIGNAL / NO_STRUCTURE / NO_DATA / START / DAY_END /
// heartbeat-ish chatter, which is what made the old feed unreadable. Those stay available
// in each bot's diagnostics feed.
const MOVE_EVENTS = new Set([
  'ENTRY_ORDER', 'ENTRY', 'EXIT', 'ENTRY_UNFILLED', 'ENTRY_CANCEL_STALE',
  'TRADE_GONE', 'FORCE_FLATTEN', 'LATE_EXIT',
]);

function etDateOf(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Every move a bot made on a given ET date, newest last.
function movesOn(logFile, dateET, botName) {
  return tailLines(logFile, 800)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.ts && MOVE_EVENTS.has(e.event) && etDateOf(e.ts) === dateET)
    .map((e) => ({
      bot: botName,
      ts: e.ts,
      event: e.event,
      symbol: e.underlying || e.symbol || null,
      qty: e.qty ?? null,
      pnl: typeof e.pnl === 'number' ? e.pnl : null,
      reason: e.reason || null,
    }));
}

// The most recent ET date on which this log recorded any move at all.
function lastSessionWithMoves(logFile) {
  const dates = tailLines(logFile, 800)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.ts && MOVE_EVENTS.has(e.event))
    .map((e) => etDateOf(e.ts));
  return dates.length ? dates[dates.length - 1] : null;
}

function getRecentEvents(n = 40) {
  return tailLines(path.join(LOGS, 'trade-log.jsonl'), n)
    .reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return { event: 'PARSE_ERROR', raw: l }; } });
}

// Scheduled-task info is expensive to query (spawns PowerShell) — cache 5 minutes.
let taskCache = { at: 0, data: [] };
function getScheduledTasks() {
  return new Promise((resolve) => {
    if (Date.now() - taskCache.at < 5 * 60 * 1000) return resolve(taskCache.data);
    const psCmd =
      "Get-ScheduledTask -TaskName 'Alpaca*' | ForEach-Object { $i = Get-ScheduledTaskInfo -TaskName $_.TaskName; [PSCustomObject]@{ name = $_.TaskName; state = [string]$_.State; nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null }; lastRun = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null }; lastResult = $i.LastTaskResult } } | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 20000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(taskCache.data);
      try {
        let data = JSON.parse(stdout);
        if (!Array.isArray(data)) data = [data];
        taskCache = { at: Date.now(), data };
        resolve(data);
      } catch { resolve(taskCache.data); }
    });
  });
}

// Did the intraday flatten actually run today?
//
// This is the failure that matters. On 2026-08-14 the machine entered Modern Standby at
// 15:27 and every runner froze through the 15:45 flatten; nothing surfaced it and it was
// found days later by reading logs. A stranded 0DTE credit spread goes to expiry, which is
// precisely what FORCE_CLOSE_AT exists to prevent.
//
// Deliberately checked against the bot's OWN DAY_END event rather than Windows power events.
// An earlier version of this used Kernel-Power 506/507 and was badly wrong: under Modern
// Standby those fire constantly (31 times in 4 days here) and mean "entered low-power idle",
// NOT "stopped" - background work continues. Naive pairing produced a claim that the box
// slept for 2424 minutes on a day the bots demonstrably traded all afternoon. DAY_END is
// written by the flatten path itself, so its absence is direct evidence, not inference.
function checkMissedFlatten(logFile, flattenAt, label) {
  const today = todayET();
  const ranToday = tailLines(logFile, 400)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .some((e) => e && e.event === 'DAY_END' && e.ts && etDateOf(e.ts) === today);

  // Decision lives in lib/healthChecks.js so it is unit-testable in both directions.
  const flag = health.shouldFlagMissedFlatten({
    weekday: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }),
    today,
    nowET: rm.nowET(),
    flattenAt,
    isHoliday: US_HOLIDAYS_2026.has(today),
    ranToday,
  });
  if (!flag) return null;

  return {
    level: 'warning',
    bot: label,
    message: `no DAY_END logged today — the ${flattenAt} ET flatten does not appear to have run. Any position left open is still open. Check whether this machine was asleep.`,
  };
}

function getLatestReview() {
  const dir = path.join(LOGS, 'reviews');
  if (!fs.existsSync(dir)) return null;
  const reports = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  if (reports.length === 0) return null;
  const name = reports[reports.length - 1];
  return { name, content: fs.readFileSync(path.join(dir, name), 'utf8') };
}

// Execution-quality stat from the fill-vs-mid logging added to runner.js's ENTRY event:
// how far actual fills land from the quoted mid at order time, as a % of that mid.
// Positive = paid above mid (cost); this is what MAX_SPREAD_PCT (gated on quoted spread
// at decision time) can't capture on its own, since the fill itself can land worse than
// the quote depending on queue position and price movement between quote and fill.
function getFillQuality() {
  const events = tailLines(path.join(LOGS, 'trade-log.jsonl'), 500)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.event === 'ENTRY' && typeof e.fillVsMidPct === 'number');
  if (events.length === 0) return null;
  const avg = (arr) => arr.reduce((a, e) => a + e.fillVsMidPct, 0) / arr.length;
  const recent = events.slice(-20);
  return {
    n: events.length,
    avgFillVsMidPct: avg(events),
    recentN: recent.length,
    recentAvgFillVsMidPct: avg(recent),
  };
}

function getLatestAdvisory() {
  const dir = path.join(LOGS, 'reviews');
  if (!fs.existsSync(dir)) return null;
  const reports = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-advisory\.md$/.test(f)).sort();
  if (reports.length === 0) return null;
  const name = reports[reports.length - 1];
  return { name, content: fs.readFileSync(path.join(dir, name), 'utf8') };
}

function getWatchdog() {
  return {
    recent: tailLines(path.join(LOGS, 'watchdog.log'), 12),
    state: readJson(path.join(LOGS, 'watchdog-state.json')),
  };
}

function getPerformanceHistory() {
  return tailLines(path.join(LOGS, 'performance-history.jsonl'), 120)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Overnight-drift is a twice-daily scheduled script, not a continuously-polling process,
// so there's no heartbeat/"alive" concept the way the ORB runner has one - health here
// just means "did enter/exit last run without an ERROR event."
async function buildOvernightStatus() {
  const [account, positions] = await Promise.all([
    ovOrders.getAccount().catch(() => null),
    ovOrders.getAllPositions().catch(() => []),
  ]);
  const state = readJson(path.join(OV_LOGS, 'state.json'));
  const guardrails = readJson(path.join(OV_LOGS, 'account-guardrails.json'));
  const recentEvents = tailLines(path.join(OV_LOGS, 'trade-log.jsonl'), 40)
    .reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return { event: 'PARSE_ERROR', raw: l }; } });
  const unrealized = positions.reduce((a, p) => a + parseFloat(p.unrealized_pl || 0), 0);
  const lastError = recentEvents.find((e) => e.event === 'ERROR');

  return {
    name: 'Overnight Drift',
    missedEntryWindow: checkOvernightStale(state),
    // lastEquity is Alpaca's own prior-trading-day close equity. It is the only baseline
    // that makes "today" honest for these bots: three of the four can hold positions
    // overnight, so realized-only P&L understates the day. equity - lastEquity is
    // mark-to-market and needs no bookkeeping of our own.
    account: account ? { equity: parseFloat(account.equity), lastEquity: parseFloat(account.last_equity), cash: parseFloat(account.cash), status: account.status } : null,
    unrealizedPl: unrealized,
    positions: positions.map((p) => ({
      symbol: p.symbol, qty: p.qty, avgEntryPrice: p.avg_entry_price,
      currentPrice: p.current_price, unrealizedPl: parseFloat(p.unrealized_pl || 0),
      unrealizedPlpc: parseFloat(p.unrealized_plpc || 0),
    })),
    guardrails,
    recentEvents,
    extra: {
      realizedPnL: state ? state.realizedPnL : 0,
      trades: state ? state.trades : 0,
      lastEnterDate: state ? state.lastEnterDate : null,
      lastExitDate: state ? state.lastExitDate : null,
      lastError: lastError ? lastError.message : null,
      strategyNote: 'Long-only: buys calls/spreads on strong up-day names near the close, sells at next open. Validated 2026-07-28 (scripts/strategy-overnight-sweep.js), +7 to +16bp/trade across thresholds tested.',
    },
  };
}

async function buildCreditSpreadStatus() {
  const [account, positions] = await Promise.all([
    csOrders.getAccount().catch(() => null),
    csOrders.getAllPositions().catch(() => []),
  ]);
  const stateFile = readJson(path.join(CS_LOGS, 'daily-state.json'));
  const state = stateFile && stateFile.date === todayET() ? stateFile : null;
  const guardrails = readJson(path.join(CS_LOGS, 'account-guardrails.json'));
  const recentEvents = tailLines(path.join(CS_LOGS, 'trade-log.jsonl'), 40)
    .reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return { event: 'PARSE_ERROR', raw: l }; } });
  const unrealized = positions.reduce((a, p) => a + parseFloat(p.unrealized_pl || 0), 0);

  return {
    name: 'Credit Spread (0DTE)',
    // These two runners write heartbeat.json exactly like ORB-15 does, but the dashboard
    // never read them - so two of the three continuous bots showed no liveness at all and
    // a dead runner would have looked identical to an idle one.
    ...heartbeatHealth(CS_LOGS),
    missedEntryWindow: checkMissedEntryWindow(path.join(CS_LOGS, 'trade-log.jsonl'), csCfg.ENTRY_WINDOW_END, 'Credit Spread'),
    // lastEquity is Alpaca's own prior-trading-day close equity. It is the only baseline
    // that makes "today" honest for these bots: three of the four can hold positions
    // overnight, so realized-only P&L understates the day. equity - lastEquity is
    // mark-to-market and needs no bookkeeping of our own.
    account: account ? { equity: parseFloat(account.equity), lastEquity: parseFloat(account.last_equity), cash: parseFloat(account.cash), status: account.status } : null,
    unrealizedPl: unrealized,
    positions: positions.map((p) => ({
      symbol: p.symbol, qty: p.qty, avgEntryPrice: p.avg_entry_price,
      currentPrice: p.current_price, unrealizedPl: parseFloat(p.unrealized_pl || 0),
      unrealizedPlpc: parseFloat(p.unrealized_plpc || 0),
    })),
    guardrails,
    recentEvents,
    extra: {
      realizedPnL: state ? state.realizedPnL : 0,
      trades: state ? state.trades : 0,
      tradedSymbols: state ? state.tradedSymbols : [],
      strategyNote: 'Sells 0DTE put credit spreads on SPY/QQQ (short ~1% OTM, $3-wide protective long). Validated 2026-07-31 over 180 real days (n=247): 71.7% win rate, +168.01bp expectancy - but the most recent month tested was a real LOSING month (-159.29bp), so a high win rate does not mean no drawdowns. Replaces the retired Trader Mimicry bot on this same account. See strategies/credit-spread/config.js. NOTE: from launch until 2026-08-13 this bot never actually held a spread — a sign error on Alpaca\'s mleg fill price inverted the exit tests, so all 3 trades it placed (08-06, 08-11, 08-13) closed on a false "profit_target" within 0.4s of filling, each for the bid-ask spread. Fixed 2026-08-13; results before that date measure the bug, not the strategy. ON PROBATION: reviewed after 20 completed trades or 2026-09-15, whichever is first — retired if win rate < 55% or realized P&L is negative. Expect materially less than +168bp: the backtest models exits at bar close with no bid/ask cost, while live round-trip slippage measured ~9–15% of credit collected (~70bp of drag).',
    },
  };
}

async function buildOvernightMomentumStatus() {
  const [account, positions] = await Promise.all([
    omOrders.getAccount().catch(() => null),
    omOrders.getAllPositions().catch(() => []),
  ]);
  // state.json, NOT daily-state.json: this bot holds positions overnight, so its state is
  // persistent rather than daily-reset (the structural difference from swing-signals, which
  // it replaces). There is no "is it today's file?" check to make - the file is always live.
  const state = readJson(path.join(OM_LOGS, 'state.json'));
  const guardrails = readJson(path.join(OM_LOGS, 'account-guardrails.json'));
  const recentEvents = tailLines(path.join(OM_LOGS, 'trade-log.jsonl'), 40)
    .reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return { event: 'PARSE_ERROR', raw: l }; } });
  const unrealized = positions.reduce((a, p) => a + parseFloat(p.unrealized_pl || 0), 0);

  return {
    name: 'Overnight Momentum',
    ...heartbeatHealth(OM_LOGS),
    missedEntryWindow: checkMissedEntryWindow(path.join(OM_LOGS, 'trade-log.jsonl'), omCfg.ENTRY_WINDOW_END, 'Overnight Momentum'),
    // lastEquity is Alpaca's own prior-trading-day close equity. It is the only baseline
    // that makes "today" honest for these bots: three of the four can hold positions
    // overnight, so realized-only P&L understates the day. equity - lastEquity is
    // mark-to-market and needs no bookkeeping of our own.
    account: account ? { equity: parseFloat(account.equity), lastEquity: parseFloat(account.last_equity), cash: parseFloat(account.cash), status: account.status } : null,
    unrealizedPl: unrealized,
    positions: positions.map((p) => ({
      symbol: p.symbol, qty: p.qty, avgEntryPrice: p.avg_entry_price,
      currentPrice: p.current_price, unrealizedPl: parseFloat(p.unrealized_pl || 0),
      unrealizedPlpc: parseFloat(p.unrealized_plpc || 0),
    })),
    guardrails,
    recentEvents,
    extra: {
      realizedPnL: state ? state.realizedPnL : 0,
      trades: state ? state.trades : 0,
      openPositions: state ? (state.openPositions || []).length : 0,
      lastEnterDate: state ? state.lastEnterDate : null,
      lastExitDate: state ? state.lastExitDate : null,
      // The headline number is deliberately paired with the caveat that most of it is not
      // alpha. A dashboard that advertises +37.5% without saying "and +12.6bp of the 15.7bp
      // is just the overnight risk premium" is the same mistake the old swing-signals note
      // made when it advertised an n=324 sample the bot could never trade.
      strategyNote: 'Buys SHARES of names up ≥1.0% on the day at 15:55 ET, sells at 09:35 ET next session. Long only. Replaced swing-signals 2026-08-14. Validated over 365 days on 46 names (scripts/strategy-overnight-shares-sweep.js): n=3311, +15.7bp/trade after 5bp costs, IS +9.6 / OOS +29.7bp, 9/13 months positive; compounded account sim at these exact settings $1000 → $1375 (+37.5%) with 5.6% max drawdown. Universe deliberately EXCLUDES the 12 names the Overnight Drift options bot trades, so the two never hold the same stock. ⚠ CAVEATS: most of this is not alpha — holding these names overnight unconditionally earned +12.6bp, so the up-1% filter adds only +7.2bp. It is long beta and has never been tested through a bear market (sample had SPY +21%, of which +18.8% accrued overnight). Real gap tail: worst trade -27.1%, and up to 5 positions are held on the same night. At $1,000 only 25 of the 46 names fit the $150 per-trade budget, which the backtest already models.',
    },
  };
}

// Portfolio-level answer to "did anything happen today, and am I up or down". Assembled
// from the already-built per-bot statuses plus their logs, so it can never disagree with
// the cards below it.
function buildOverview(strategies) {
  const logs = {
    'orb15': path.join(LOGS, 'trade-log.jsonl'),
    'overnight': path.join(OV_LOGS, 'trade-log.jsonl'),
    'credit-spread': path.join(CS_LOGS, 'trade-log.jsonl'),
    'overnight-momentum': path.join(OM_LOGS, 'trade-log.jsonl'),
  };
  const session = marketSession();
  const today = todayET();

  // --- money -------------------------------------------------------------------------
  let equity = 0, lastEquity = 0, unrealized = 0, openPositions = 0, accountsReporting = 0;
  for (const s of strategies) {
    if (!s.account) continue;
    accountsReporting += 1;
    equity += s.account.equity || 0;
    lastEquity += Number.isFinite(s.account.lastEquity) ? s.account.lastEquity : (s.account.equity || 0);
    unrealized += s.unrealizedPl || 0;
    openPositions += (s.positions || []).length;
  }
  const todayPnl = equity - lastEquity;

  // --- moves -------------------------------------------------------------------------
  let timeline = [];
  for (const s of strategies) {
    const f = logs[s.key];
    if (f) timeline.push(...movesOn(f, today, s.name));
  }
  // If today produced nothing (weekend, holiday, or simply a quiet session), fall back to
  // the most recent day that DID trade, so the page still answers "what happened last".
  let timelineDate = today, isFallback = false;
  if (timeline.length === 0) {
    const candidates = strategies.map((s) => (logs[s.key] ? lastSessionWithMoves(logs[s.key]) : null)).filter(Boolean);
    const prev = candidates.sort().pop();
    if (prev) {
      timelineDate = prev;
      isFallback = true;
      for (const s of strategies) {
        const f = logs[s.key];
        if (f) timeline.push(...movesOn(f, prev, s.name));
      }
    }
  }
  timeline.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const fills = timeline.filter((e) => e.event === 'ENTRY' || e.event === 'EXIT');
  const closes = timeline.filter((e) => e.event === 'EXIT' && typeof e.pnl === 'number');
  const sessionRealized = closes.reduce((a, e) => a + e.pnl, 0);

  // --- health: entirely separate from market activity ---------------------------------
  // A bot with no heartbeat concept (scheduled scripts) is not "down" - it is judged by
  // whether its scheduled runs actually happened, which is what missedEntryWindow carries.
  const problems = [];
  for (const s of strategies) {
    if (typeof s.alive === 'boolean' && !s.alive) {
      problems.push({ level: 'critical', bot: s.name, message: `runner is down (last heartbeat ${s.heartbeatAgeSec == null ? 'never' : s.heartbeatAgeSec + 's'} ago)` });
    }
    if (s.missedEntryWindow && s.missedEntryWindow.missed) {
      problems.push({ level: 'warning', bot: s.name, message: s.missedEntryWindow.reason });
    }
    if (s.guardrails && s.guardrails.pausedForReview) {
      problems.push({ level: 'warning', bot: s.name, message: `paused for review: ${s.guardrails.pausedReason || 'unknown'}` });
    }
    if (!s.account) {
      problems.push({ level: 'warning', bot: s.name, message: 'broker account unreachable' });
    }
  }

  // The dangerous machine-level failure is a missed 15:45 flatten - that is what strands a
  // 0DTE credit spread into expiry, and it is what happened on 2026-08-14. Checked against
  // the bots' own DAY_END events rather than inferred from OS power events, which under
  // Modern Standby fire constantly without meaning anything stopped.
  for (const [name, logFile, flattenAt] of [
    ['ORB-15', path.join(LOGS, 'trade-log.jsonl'), cfg.FORCE_FLATTEN_AT],
    ['Credit Spread (0DTE)', path.join(CS_LOGS, 'trade-log.jsonl'), csCfg.FORCE_CLOSE_AT],
  ]) {
    const miss = checkMissedFlatten(logFile, flattenAt, name);
    if (miss) problems.push(miss);
  }
  const health = problems.some((p) => p.level === 'critical') ? 'critical'
    : problems.length ? 'warning' : 'ok';

  // --- the one-sentence verdict -------------------------------------------------------
  // Deterministic. Reads the two axes in priority order: broken first, then market state,
  // then actual activity. Never says "all good" purely because nothing errored.
  let verdict, tone;
  if (health === 'critical') {
    verdict = `${problems.filter((p) => p.level === 'critical').length} bot(s) not running — today's strategy may not have executed.`;
    tone = 'critical';
  } else if (fills.length > 0 && !isFallback) {
    verdict = `${fills.length} fill${fills.length === 1 ? '' : 's'} today across ${new Set(fills.map((f) => f.bot)).size} bot(s).`;
    tone = todayPnl >= 0 ? 'good' : 'loss';
  } else if (!session.isTradingDay) {
    verdict = `No trades — ${session.state === 'weekend' ? 'it is the weekend' : 'markets are closed for a holiday'}. Next open ${session.nextOpen}.`;
    tone = 'idle';
  } else if (session.state === 'premarket') {
    verdict = 'No trades yet — the session has not opened.';
    tone = 'idle';
  } else if (problems.length) {
    verdict = 'No trades today, and one or more bots need attention — see below.';
    tone = 'warning';
  } else if (session.state === 'open') {
    verdict = 'No trades yet today — bots are running and no setup has qualified.';
    tone = 'idle';
  } else {
    verdict = `No trades today — the session closed without a qualifying setup. Next open ${session.nextOpen}.`;
    tone = 'idle';
  }

  return {
    session,
    equity,
    lastEquity,
    todayPnl,
    todayPnlPct: lastEquity ? (todayPnl / lastEquity) * 100 : 0,
    unrealized,
    openPositions,
    accountsReporting,
    accountsTotal: strategies.length,
    movesToday: isFallback ? 0 : fills.length,
    verdict,
    tone,
    health,
    problems,
    timeline: {
      date: timelineDate,
      isFallback,
      sessionRealized,
      fills: fills.length,
      events: timeline.slice(-60),
    },
  };
}

// Underlying stock tickers currently held across ALL bots, read from each bot's own
// tracked-trade state (the `underlying` field) rather than derived from raw option
// position symbols - that's the field that actually names "the stock", not the OCC
// contract, and every bot's state file already carries it.
function getHeldUnderlyings() {
  const underlyings = new Set();
  const orbState = readJson(path.join(LOGS, 'daily-state.json'));
  if (orbState && orbState.date === todayET() && Array.isArray(orbState.openTrades)) {
    for (const t of orbState.openTrades) if (t.underlying) underlyings.add(t.underlying);
  }
  const ovState = readJson(path.join(OV_LOGS, 'state.json'));
  if (ovState && Array.isArray(ovState.openPositions)) {
    for (const t of ovState.openPositions) if (t.underlying) underlyings.add(t.underlying);
  }
  const csState = readJson(path.join(CS_LOGS, 'daily-state.json'));
  if (csState && csState.date === todayET() && Array.isArray(csState.openTrades)) {
    for (const t of csState.openTrades) if (t.underlying) underlyings.add(t.underlying);
  }
  const swState = readJson(path.join(OM_LOGS, 'daily-state.json'));
  if (swState && swState.date === todayET() && Array.isArray(swState.openTrades)) {
    for (const t of swState.openTrades) if (t.symbol) underlyings.add(t.symbol);
  }
  return [...underlyings];
}

// Recent 5-min bars per held underlying, for the dashboard's live price charts. Cached
// briefly since this is real Alpaca data-API usage, not free to poll on every request.
let priceChartCache = { at: 0, symbols: '', data: {} };
async function getPriceCharts(symbols) {
  if (symbols.length === 0) return {};
  const key = symbols.slice().sort().join(',');
  if (Date.now() - priceChartCache.at < 60 * 1000 && priceChartCache.symbols === key) {
    return priceChartCache.data;
  }
  try {
    const bars = await md.getBars(symbols, 2);
    const data = {};
    for (const symbol of symbols) {
      data[symbol] = (bars[symbol] || []).map((b) => ({ t: b.t, c: b.c }));
    }
    priceChartCache = { at: Date.now(), symbols: key, data };
    return data;
  } catch (e) {
    return priceChartCache.symbols === key ? priceChartCache.data : {};
  }
}

// Diagnostic-only cross-check of Alpaca's own price feed against two independent free
// sources (Yahoo Finance's unofficial endpoint, Finnhub's free-tier quote), for whatever
// the bots currently hold. NOT wired into any bot's trading logic - this can never change
// an order, it only flags on the dashboard if a source disagrees with Alpaca by more than
// DIVERGENCE_THRESHOLD, which would suggest a stale/bad Alpaca quote. Two independent
// sources agreeing is stronger evidence than one. Cached like getPriceCharts - Finnhub's
// free tier is 60 calls/min and Yahoo's endpoint is undocumented/abuse-prone, neither
// should be hit on every 15s dashboard poll.
const DIVERGENCE_THRESHOLD = 0.005; // 0.5%
let dataQualityCache = { at: 0, symbols: '', data: {} };
async function getDataQualityChecks(symbols, priceCharts) {
  if (symbols.length === 0) return {};
  const key = symbols.slice().sort().join(',');
  if (Date.now() - dataQualityCache.at < 60 * 1000 && dataQualityCache.symbols === key) {
    return dataQualityCache.data;
  }
  const data = {};
  await Promise.all(symbols.map(async (symbol) => {
    const bars = priceCharts[symbol] || [];
    const alpacaPrice = bars.length ? bars[bars.length - 1].c : null;
    if (alpacaPrice == null) return;
    const [yahoo_, finnhub_] = await Promise.all([
      yahoo.getYahooPrice(symbol),
      finnhub.getQuote(symbol).catch(() => null),
    ]);
    const sources = {};
    let diverged = false;
    if (yahoo_) {
      const diffPct = Math.abs(yahoo_.price - alpacaPrice) / alpacaPrice;
      sources.yahoo = { price: yahoo_.price, asOf: yahoo_.asOf, diffPct, diverged: diffPct > DIVERGENCE_THRESHOLD };
      diverged = diverged || sources.yahoo.diverged;
    }
    if (finnhub_) {
      const diffPct = Math.abs(finnhub_.price - alpacaPrice) / alpacaPrice;
      sources.finnhub = { price: finnhub_.price, asOf: finnhub_.asOf, diffPct, diverged: diffPct > DIVERGENCE_THRESHOLD };
      diverged = diverged || sources.finnhub.diverged;
    }
    if (Object.keys(sources).length === 0) return; // both sources failed - omit silently, diagnostic only
    data[symbol] = { alpacaPrice, sources, diverged };
  }));
  dataQualityCache = { at: Date.now(), symbols: key, data };
  return data;
}

async function buildStatus() {
  const heartbeat = readJson(path.join(LOGS, 'heartbeat.json'));
  const heartbeatAgeSec = heartbeat ? Math.round((Date.now() - new Date(heartbeat.ts).getTime()) / 1000) : null;
  const marketOpen = isMarketHours();
  // Runner heartbeats every 20s around the clock (it idles off-hours but still ticks).
  const alive = heartbeatAgeSec !== null && heartbeatAgeSec < 120;

  const [account, positions, tasks] = await Promise.all([
    orders.getAccount().catch(() => null),
    orders.getAllPositions().catch(() => []),
    getScheduledTasks(),
  ]);

  const stateFile = readJson(path.join(LOGS, 'daily-state.json'));
  const dailyState = stateFile && stateFile.date === todayET() ? stateFile : null;
  const guardrails = readJson(path.join(LOGS, 'account-guardrails.json'));
  const missedEntryWindow = checkMissedEntryWindow(path.join(LOGS, 'trade-log.jsonl'), cfg.ORB_ENTRY_CUTOFF, 'ORB-15');

  const unrealized = positions.reduce((a, p) => a + parseFloat(p.unrealized_pl || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    marketOpen,
    alive,
    heartbeatAgeSec,
    missedEntryWindow,
    strategy: {
      name: 'ORB-15',
      universe: cfg.UNIVERSE,
      entryWindow: `09:45-${cfg.ORB_ENTRY_CUTOFF} ET`,
      flattenAt: cfg.FORCE_FLATTEN_AT + ' ET',
      riskPctPerTrade: cfg.RISK_PCT_PER_TRADE,
      maxConcurrent: cfg.MAX_CONCURRENT_POSITIONS,
      dailyLossStopPct: cfg.DAILY_LOSS_STOP_PCT,
    },
    account: account ? {
      equity: parseFloat(account.equity),
      lastEquity: parseFloat(account.last_equity), // prior trading day's close - the "today" baseline
      cash: parseFloat(account.cash),
      status: account.status,
    } : null,
    unrealizedPl: unrealized,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avgEntryPrice: p.avg_entry_price,
      currentPrice: p.current_price,
      unrealizedPl: parseFloat(p.unrealized_pl || 0),
      unrealizedPlpc: parseFloat(p.unrealized_plpc || 0),
    })),
    dailyState: dailyState ? {
      trades: dailyState.trades,
      realizedPnL: dailyState.realizedPnL,
      startEquity: dailyState.startEquity,
      openTrades: dailyState.openTrades,
      tradedUnderlyings: dailyState.tradedUnderlyings,
    } : null,
    guardrails,
    recentEvents: getRecentEvents(),
    watchdog: getWatchdog(),
    tasks,
    latestReview: getLatestReview(),
    latestAdvisory: getLatestAdvisory(),
    fillQuality: getFillQuality(),
    performanceHistory: getPerformanceHistory(),
  };
}

// The home-screen icon and web manifest for the iPhone dashboard (/phone) are served
// without auth. iOS fetches the touch icon out of the page's own context when a site is
// added to the home screen, and does not reliably attach stored basic-auth credentials to
// that request; behind auth it 401s and the installed app silently gets a screenshot for
// an icon instead. These two files are static branding with no account data in them, so
// exempting them costs nothing. Everything that reads the accounts stays behind auth.
// Explicitly enumerated rather than joined from the URL: this server is tunnelled to the
// public internet, and a file path built out of req.url is how a traversal bug gets in.
const PHONE_ICONS = {
  '/assets/phone-icon-180.png': 'phone-icon-180.png',
  '/assets/phone-icon-512.png': 'phone-icon-512.png',
};
// /sw.js joins them: a service worker script fetched without credentials 401s, which
// fails registration outright. It is caching logic with no account data in it.
const PUBLIC_ASSETS = new Set(['/manifest.webmanifest', '/sw.js', ...Object.keys(PHONE_ICONS)]);

const server = http.createServer(async (req, res) => {
  if (!PUBLIC_ASSETS.has(req.url) && !checkAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ORB Bot Dashboard"', 'Content-Type': 'text/plain' });
    res.end('Authentication required');
    return;
  }

  if (req.url === '/api/status') {
    try {
      const status = await buildStatus();
      // Spread-level positions, plus intraday underlying bars for whatever ORB-15 alone is
      // holding. Scoped to this bot deliberately - getHeldUnderlyings() spans all four, and
      // charting another bot's holdings on the ORB console would be actively misleading.
      const orbOpenTrades = (status.dailyState && status.dailyState.openTrades) || [];
      status.positionGroups = buildPositionGroups(closeGroupFor, 'orb15', status.positions, orbOpenTrades);
      const underlyings = [...new Set(status.positionGroups.map((g) => g.underlying))];
      status.priceCharts = await getPriceCharts(underlyings);
      status.session = marketSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/close' && req.method === 'POST') {
    try {
      // Basic auth alone does not protect a state-changing POST: a browser that has cached
      // the credentials will attach them to a cross-site form submission too, so any page
      // the user visits could close their positions. This dashboard is tunnelled publicly
      // over ngrok, which makes that a real path rather than a theoretical one. Same-origin
      // is asserted from Origin, falling back to Referer for older clients; a request with
      // neither is rejected rather than trusted.
      const origin = req.headers.origin || null;
      const referer = req.headers.referer || null;
      const host = req.headers.host || '';
      const sameOrigin = (value) => {
        if (!value) return false;
        try { return new URL(value).host === host; } catch { return false; }
      };
      if (!sameOrigin(origin) && !sameOrigin(referer)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cross-origin close requests are refused' }));
        return;
      }

      const body = JSON.parse((await readBody(req)) || '{}');
      const symbol = typeof body.symbol === 'string' ? body.symbol : null;
      // Defaults to ORB-15 so the older /orb15 page, which predates multi-bot closing and
      // sends no strategy, keeps hitting the account it always did.
      const key = typeof body.strategy === 'string' ? body.strategy : 'orb15';
      const strat = STRATEGIES[key];
      if (!symbol) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'symbol required' }));
        return;
      }
      if (!strat) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown strategy ${key}` }));
        return;
      }
      // Only allow closing a symbol that's actually an open position right now —
      // guards against a stale UI sending a symbol that's already gone.
      const positions = await strat.orders.getAllPositions();
      const match = positions.find((p) => p.symbol === symbol);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `no open position for ${symbol} on ${strat.name}` }));
        return;
      }
      // Re-resolve the leg group server-side rather than trusting the browser's copy.
      const group = closeGroupFor(key, symbol);
      const held = group.symbols.filter((sym) => positions.some((p) => p.symbol === sym));
      let closed;
      if (group.closeSpread && held.length === group.symbols.length) {
        // All legs still present: close as one mleg order, so there's no window where a
        // short leg sits uncovered between two separate close requests.
        await group.closeSpread();
        closed = group.symbols;
      } else {
        // Partially-filled or partially-closed structure — no valid mleg order to send, so
        // close leg by leg, shorts (negative qty) first to minimise the uncovered window.
        const ordered = held.slice().sort((a, b) => {
          const q = (sym) => parseFloat((positions.find((p) => p.symbol === sym) || {}).qty || 0);
          return q(a) - q(b);
        });
        for (const sym of ordered) await strat.orders.closePositionMarket(sym);
        closed = ordered;
      }
      // Deliberately does NOT edit the bot's state file: the runner owns that file and
      // would overwrite anything written here. Each bot reconciles a vanished position on
      // its next pass (TRADE_GONE) instead.
      fs.appendFileSync(path.join(strat.logs, 'trade-log.jsonl'), JSON.stringify({
        ts: new Date().toISOString(), event: 'MANUAL_CLOSE', symbol, qty: match.qty,
        legs: closed.length > 1 ? closed : undefined,
      }) + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, symbol, closed }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/multi-status') {
    try {
      const orbStatus = await buildStatus();
      const overnightStatus = await buildOvernightStatus();
      const creditSpreadStatus = await buildCreditSpreadStatus();
      const overnightMomentumStatus = await buildOvernightMomentumStatus();
      const heldUnderlyings = getHeldUnderlyings();
      const priceCharts = await getPriceCharts(heldUnderlyings);
      const dataQualityChecks = await getDataQualityChecks(heldUnderlyings, priceCharts);
      // `key` is what the dashboard's Close buttons post back to /api/close to name the
      // account; `closesWith` tells each row which sibling legs go with it.
      const strategies = [
        { key: 'orb15', name: 'ORB-15', ...orbStatus, positions: annotateCloseGroups('orb15', orbStatus.positions) },
        { key: 'overnight', ...overnightStatus, positions: annotateCloseGroups('overnight', overnightStatus.positions) },
        { key: 'credit-spread', ...creditSpreadStatus, positions: annotateCloseGroups('credit-spread', creditSpreadStatus.positions) },
        { key: 'overnight-momentum', ...overnightMomentumStatus, positions: annotateCloseGroups('overnight-momentum', overnightMomentumStatus.positions) },
      ];
      const overview = buildOverview(strategies);
      // Per-bot "today" line, derived from the same timeline the overview uses so a card can
      // never disagree with the header above it.
      for (const s of strategies) {
        const mine = overview.timeline.events.filter((e) => e.bot === s.name);
        const myFills = mine.filter((e) => e.event === 'ENTRY' || e.event === 'EXIT');
        s.today = {
          date: overview.timeline.date,
          isFallback: overview.timeline.isFallback,
          fills: myFills.length,
          realized: mine.filter((e) => e.event === 'EXIT' && typeof e.pnl === 'number').reduce((a, e) => a + e.pnl, 0),
          pnl: s.account && Number.isFinite(s.account.lastEquity) ? s.account.equity - s.account.lastEquity : null,
          lastActivityTs: mine.length ? mine[mine.length - 1].ts : null,
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        generatedAt: new Date().toISOString(),
        overview,
        strategies,
        priceCharts,
        dataQualityChecks,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Root is now the multi-bot overview (all 3 strategies) - the detailed ORB-15-only view
  // (equity chart, watchdog, scheduled tasks, nightly review) moved to /orb15. /multi is
  // kept as an alias so the old bookmark/link still works.
  // 2026-08-19: `/` is the ORB-15 operator console. The four-bot portfolio view moved to
  // /multi (and keeps its old /orb15 alias pointing at this page, so existing bookmarks for
  // either address still land somewhere sensible).
  if (req.url === '/' || req.url === '/index.html' || req.url === '/orb15' || req.url === '/orb15.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'status.html'), 'utf8'));
    return;
  }

  if (req.url === '/multi' || req.url === '/multi.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'multi.html'), 'utf8'));
    return;
  }

  // The phone dashboard. Same data as /multi, laid out for one thumb and a 390px screen,
  // and installable to the iPhone home screen (see PHONE-APP.md).
  if (req.url === '/phone' || req.url === '/phone.html') {
    // The marker the service worker uses to tell this page apart from an ngrok offline
    // page, a captive portal or a proxy error - all of which are valid HTTP responses
    // carrying someone else's HTML, and none of which should overwrite the cached shell.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Bot-Dashboard': '1' });
    res.end(fs.readFileSync(path.join(__dirname, 'phone.html'), 'utf8'));
    return;
  }

  if (req.url === '/sw.js') {
    // no-cache so an updated worker is actually noticed; the worker itself is what decides
    // how long anything else lives.
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'));
    return;
  }

  if (req.url === '/manifest.webmanifest') {
    // start_url is what the home-screen shortcut opens, and display:standalone is what
    // drops Safari's chrome. Both have to come from the manifest - the old apple-mobile-
    // web-app-capable meta tag alone no longer does it on current iOS.
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(JSON.stringify({
      name: 'Trading Bots', short_name: 'Bots',
      description: 'Live status of the Alpaca day-trading bots.',
      start_url: '/phone', scope: '/', display: 'standalone',
      background_color: '#101110', theme_color: '#101110', orientation: 'portrait',
      icons: [
        { src: '/assets/phone-icon-180.png', sizes: '180x180', type: 'image/png' },
        { src: '/assets/phone-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    }));
    return;
  }

  if (PHONE_ICONS[req.url]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(fs.readFileSync(path.join(__dirname, 'assets', PHONE_ICONS[req.url])));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Status dashboard running at http://localhost:${PORT}`);
});
