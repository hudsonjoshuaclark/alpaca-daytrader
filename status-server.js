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
const swOrders = require('./strategies/swing-signals/orders');
const yahoo = require('./lib/yahooFinance');
const finnhub = require('./lib/finnhub');

const PORT = 4321;
const LOGS = path.join(__dirname, 'logs');
const OV_DIR = path.join(__dirname, 'strategies', 'overnight-drift');
const OV_LOGS = path.join(OV_DIR, 'logs');
const CS_DIR = path.join(__dirname, 'strategies', 'credit-spread');
const CS_LOGS = path.join(CS_DIR, 'logs');
const SW_DIR = path.join(__dirname, 'strategies', 'swing-signals');
const SW_LOGS = path.join(SW_DIR, 'logs');

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
  'swing': {
    name: 'Swing Signals (RSI)',
    orders: swOrders,
    logs: SW_LOGS,
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
function checkMissedEntryWindow() {
  const today = todayET();
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return null;

  const startTimes = tailLines(path.join(LOGS, 'trade-log.jsonl'), 500)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.event === 'START' && e.ts
      && new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today);
  const nowET = rm.nowET();

  if (startTimes.length === 0) {
    if (nowET >= cfg.ORB_ENTRY_CUTOFF) {
      return { missed: true, reason: `No runner start logged yet today, and it's already past the ${cfg.ORB_ENTRY_CUTOFF} ET entry cutoff — check whether the machine was asleep.` };
    }
    return null;
  }

  const firstStart = startTimes[0];
  const firstStartTimeET = new Date(firstStart.ts).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  if (firstStartTimeET >= cfg.ORB_ENTRY_CUTOFF) {
    return { missed: true, reason: `Runner's first start today was ${firstStartTimeET} ET, after the ${cfg.ORB_ENTRY_CUTOFF} ET entry cutoff — likely missed the whole entry window (e.g. the machine was asleep).` };
  }
  return null;
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
    account: account ? { equity: parseFloat(account.equity), cash: parseFloat(account.cash), status: account.status } : null,
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
    account: account ? { equity: parseFloat(account.equity), cash: parseFloat(account.cash), status: account.status } : null,
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
      strategyNote: 'Sells 0DTE put credit spreads on SPY/QQQ (short ~1% OTM, $3-wide protective long). Validated 2026-07-31 over 180 real days (n=247): 71.7% win rate, +168.01bp expectancy - but the most recent month tested was a real LOSING month (-159.29bp), so a high win rate does not mean no drawdowns. Replaces the retired Trader Mimicry bot on this same account. See strategies/credit-spread/config.js.',
    },
  };
}

async function buildSwingSignalsStatus() {
  const [account, positions] = await Promise.all([
    swOrders.getAccount().catch(() => null),
    swOrders.getAllPositions().catch(() => []),
  ]);
  const stateFile = readJson(path.join(SW_LOGS, 'daily-state.json'));
  const state = stateFile && stateFile.date === todayET() ? stateFile : null;
  const guardrails = readJson(path.join(SW_LOGS, 'account-guardrails.json'));
  const recentEvents = tailLines(path.join(SW_LOGS, 'trade-log.jsonl'), 40)
    .reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return { event: 'PARSE_ERROR', raw: l }; } });
  const unrealized = positions.reduce((a, p) => a + parseFloat(p.unrealized_pl || 0), 0);

  return {
    name: 'Swing Signals (RSI)',
    account: account ? { equity: parseFloat(account.equity), cash: parseFloat(account.cash), status: account.status } : null,
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
      openPositions: state ? state.openTrades.length : 0,
      strategyNote: 'Direct stock shares (not options): buys on an RSI(14) pullback-through-30 in an EMA(50) uptrend, across a 56-symbol watchlist. Validated 2026-08-02 over 365 real days (n=324, clears this project\'s 200-trade bar): 20.24bp/trade expectancy, 51.9% win rate, +65.58% summed return, 7/12 months positive. Deliberately uses a tighter 1.5% stop / 2.0% target instead of a higher-expectancy wide setting (46.48bp/trade) - the wide setting almost never actually triggered its stop/target (95% of trades just rode to the close), so this tighter setting was chosen because the stop-loss/take-profit genuinely drive most exits instead of sitting dormant. March 2026 was a real losing month, consistent with most other candidates/bots tested that month.',
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
  const swState = readJson(path.join(SW_LOGS, 'daily-state.json'));
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
  const missedEntryWindow = checkMissedEntryWindow();

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

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ORB Bot Dashboard"', 'Content-Type': 'text/plain' });
    res.end('Authentication required');
    return;
  }

  if (req.url === '/api/status') {
    try {
      const status = await buildStatus();
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
      const swingSignalsStatus = await buildSwingSignalsStatus();
      const heldUnderlyings = getHeldUnderlyings();
      const priceCharts = await getPriceCharts(heldUnderlyings);
      const dataQualityChecks = await getDataQualityChecks(heldUnderlyings, priceCharts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        generatedAt: new Date().toISOString(),
        // `key` is what the dashboard's Close buttons post back to /api/close to name the
        // account; `closesWith` tells each row which sibling legs go with it.
        strategies: [
          { key: 'orb15', name: 'ORB-15', ...orbStatus, positions: annotateCloseGroups('orb15', orbStatus.positions) },
          { key: 'overnight', ...overnightStatus, positions: annotateCloseGroups('overnight', overnightStatus.positions) },
          { key: 'credit-spread', ...creditSpreadStatus, positions: annotateCloseGroups('credit-spread', creditSpreadStatus.positions) },
          { key: 'swing', ...swingSignalsStatus, positions: annotateCloseGroups('swing', swingSignalsStatus.positions) },
        ],
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
  if (req.url === '/' || req.url === '/index.html' || req.url === '/multi' || req.url === '/multi.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'multi.html'), 'utf8'));
    return;
  }

  if (req.url === '/orb15' || req.url === '/orb15.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'status.html'), 'utf8'));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Status dashboard running at http://localhost:${PORT}`);
});
