const http = require('http');
const fs = require('fs');
const path = require('path');
const orders = require('./lib/orders');
const rm = require('./lib/riskManager');
const screener = require('./lib/screener');

const PORT = 4321;
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.jsonl');
const HEARTBEAT_FILE = path.join(__dirname, 'logs', 'heartbeat.json');

function isMarketHours() {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return false;
  const t = rm.nowET();
  return t >= '09:30' && t < '16:00';
}

function getRecentEvents(n = 25) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n).reverse().map((l) => {
    try { return JSON.parse(l); } catch { return { event: 'PARSE_ERROR', raw: l }; }
  });
}

function getHeartbeat() {
  if (!fs.existsSync(HEARTBEAT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); } catch { return null; }
}

async function buildStatus() {
  const heartbeat = getHeartbeat();
  const heartbeatAgeSec = heartbeat ? (Date.now() - new Date(heartbeat.ts).getTime()) / 1000 : null;
  const marketOpen = isMarketHours();
  // Bot is considered "alive" if it heartbeat within the last 90s during market hours,
  // or if it's outside market hours (where it's expected to idle without ticking).
  const alive = !marketOpen || (heartbeatAgeSec !== null && heartbeatAgeSec < 90);

  const [account, positions] = await Promise.all([
    orders.getAccount().catch(() => null),
    orders.getAllPositions().catch(() => []),
  ]);

  const universe = screener.getTodaysUniverse();
  const stateFile = path.join(__dirname, 'logs', 'daily-state.json');
  const dailyState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;

  return {
    generatedAt: new Date().toISOString(),
    marketOpen,
    alive,
    heartbeatAgeSec,
    account: account ? { equity: account.equity, cash: account.cash, status: account.status } : null,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avgEntryPrice: p.avg_entry_price,
      currentPrice: p.current_price,
      unrealizedPl: p.unrealized_pl,
      unrealizedPlpc: p.unrealized_plpc,
    })),
    universe: universe ? universe.symbols : [],
    dailyState,
    recentEvents: getRecentEvents(),
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
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'status.html'), 'utf8'));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Status dashboard running at http://localhost:${PORT}`);
});
