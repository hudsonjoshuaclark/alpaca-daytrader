// Live status dashboard for the ORB bot + its automation stack.
// Serves status.html at / and aggregated live state at /api/status:
// runner health, account, positions, today's activity, watchdog, scheduled tasks,
// latest nightly review, and equity history.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./lib/config');
const orders = require('./lib/orders');
const rm = require('./lib/riskManager');

const PORT = 4321;
const LOGS = path.join(__dirname, 'logs');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
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

  const unrealized = positions.reduce((a, p) => a + parseFloat(p.unrealized_pl || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    marketOpen,
    alive,
    heartbeatAgeSec,
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
    performanceHistory: getPerformanceHistory(),
  };
}

const server = http.createServer(async (req, res) => {
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

  if (req.url === '/' || req.url === '/index.html') {
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
