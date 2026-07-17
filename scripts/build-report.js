// Reads logs/trade-log.jsonl, pairs ENTRY with its EXIT/FORCE_FLATTEN, and writes
// an HTML report (color-coded trade chart) to reports/<date>.html
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'trade-log.jsonl');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function loadEvents() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs
    .readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildTrades(events) {
  const openBySymbol = {}; // symbol -> queue of ENTRY events (FIFO)
  const trades = [];

  for (const ev of events) {
    if (ev.event === 'ENTRY') {
      openBySymbol[ev.contract] = openBySymbol[ev.contract] || [];
      openBySymbol[ev.contract].push(ev);
    } else if (ev.event === 'EXIT' || ev.event === 'FORCE_FLATTEN') {
      const queue = openBySymbol[ev.symbol];
      const entry = queue && queue.length ? queue.shift() : null;
      trades.push({
        contract: ev.symbol,
        underlying: entry ? entry.symbol : ev.symbol.replace(/\d.*$/, ''),
        direction: entry ? entry.direction : null,
        qty: entry ? entry.qty : null,
        entryPrice: entry ? entry.premium : null,
        entryTime: entry ? entry.ts : null,
        exitTime: ev.ts,
        exitReason: ev.reason || 'force_flatten',
        pnl: ev.pnl,
      });
    }
  }
  return trades;
}

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
}

function buildHTML(trades, dateLabel) {
  const wins = trades.filter((t) => t.pnl >= 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const totalPnL = trades.reduce((s, t) => s + (t.pnl || 0), 0);

  const maxAbs = Math.max(1, ...trades.map((t) => Math.abs(t.pnl || 0)));
  const barMaxHeight = 160; // px, half-height above/below baseline

  const bars = trades
    .map((t, i) => {
      const isWin = t.pnl >= 0;
      const h = Math.max(4, Math.round((Math.abs(t.pnl) / maxAbs) * barMaxHeight));
      const color = isWin ? 'var(--good)' : 'var(--critical)';
      const label = `${t.underlying || ''} ${t.direction === 'bullish' ? 'CALL' : t.direction === 'bearish' ? 'PUT' : ''}`.trim();
      return `
        <div class="trade-col" tabindex="0" role="img" aria-label="Trade ${i + 1}: ${label || t.contract}, ${isWin ? 'win' : 'loss'} ${fmtMoney(t.pnl)}">
          <div class="bar-track">
            ${isWin
              ? `<div class="bar bar-win" style="height:${h}px; background:${color}"><span class="bar-value">${fmtMoney(t.pnl)}</span></div>`
              : `<div class="bar-spacer-top" style="height:${barMaxHeight - h}px"></div>`
            }
          </div>
          <div class="baseline"></div>
          <div class="bar-track bar-track-down">
            ${!isWin
              ? `<div class="bar bar-loss" style="height:${h}px; background:${color}"><span class="bar-value bar-value-down">${fmtMoney(t.pnl)}</span></div>`
              : ''
            }
          </div>
          <div class="trade-label">${label || '—'}<br><span class="muted">${fmtTime(t.exitTime)}</span></div>
        </div>`;
    })
    .join('\n');

  const tableRows = trades
    .map(
      (t, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${t.contract}</td>
          <td>${t.direction === 'bullish' ? 'Call' : t.direction === 'bearish' ? 'Put' : '—'}</td>
          <td>${t.qty ?? '—'}</td>
          <td>${t.entryPrice != null ? '$' + t.entryPrice.toFixed(2) : '—'}</td>
          <td>${fmtTime(t.entryTime)}</td>
          <td>${fmtTime(t.exitTime)}</td>
          <td>${t.exitReason}</td>
          <td class="${t.pnl >= 0 ? 'text-good' : 'text-critical'}">${fmtMoney(t.pnl)}</td>
        </tr>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Trade Report — ${dateLabel}</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e1e0d9;
    --baseline: #c3c2b7;
    --good: #0ca30c;
    --critical: #d03b3b;
    --good-text: #006300;
    --critical-text: #b53030;
    --border: rgba(11,11,11,0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --baseline: #383835;
      --good: #0ca30c;
      --critical: #e66767;
      --good-text: #0ca30c;
      --critical-text: #e66767;
      --border: rgba(255,255,255,0.10);
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --gridline: #2c2c2a;
    --baseline: #383835;
    --good: #0ca30c;
    --critical: #e66767;
    --good-text: #0ca30c;
    --critical-text: #e66767;
    --border: rgba(255,255,255,0.10);
  }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .viz-root {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page);
    color: var(--text-primary);
    padding: 24px;
    min-height: 100vh;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    max-width: 1000px;
    margin: 0 auto 20px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: var(--text-secondary); font-size: 13px; margin-bottom: 24px; }
  .legend { display: flex; gap: 16px; align-items: center; margin-bottom: 12px; font-size: 13px; color: var(--text-secondary); }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; }
  .chart-scroll { overflow-x: auto; }
  .chart {
    display: flex;
    align-items: stretch;
    gap: 4px;
    min-width: min-content;
    padding: 8px 8px 0;
  }
  .trade-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 64px;
    flex-shrink: 0;
  }
  .bar-track { height: 168px; display: flex; align-items: flex-end; justify-content: center; width: 100%; }
  .bar-track-down { align-items: flex-start; height: 168px; }
  .bar { width: 24px; border-radius: 4px 4px 0 0; position: relative; }
  .bar-loss { border-radius: 0 0 4px 4px; }
  .bar-value {
    position: absolute; top: -18px; left: 50%; transform: translateX(-50%);
    font-size: 11px; color: var(--text-secondary); white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .bar-value-down { top: auto; bottom: -18px; }
  .bar-spacer-top { width: 24px; }
  .baseline { height: 2px; background: var(--baseline); width: 100%; }
  .trade-label { font-size: 10px; color: var(--text-secondary); text-align: center; margin-top: 8px; line-height: 1.4; }
  .muted { color: var(--text-muted); }
  .summary {
    display: flex; gap: 32px; margin-top: 28px; padding-top: 20px;
    border-top: 1px solid var(--gridline); flex-wrap: wrap;
  }
  .summary-item { display: flex; flex-direction: column; gap: 4px; }
  .summary-label { font-size: 12px; color: var(--text-secondary); }
  .summary-value { font-size: 24px; font-weight: 600; }
  .text-good { color: var(--good-text); }
  .text-critical { color: var(--critical-text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--gridline); }
  th { color: var(--text-secondary); font-weight: 500; font-size: 12px; }
  td { font-variant-numeric: tabular-nums; }
  .empty-state { color: var(--text-secondary); padding: 40px 0; text-align: center; }
  details summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
<div class="viz-root">
  <div class="card">
    <h1>Trade Report — ${dateLabel}</h1>
    <div class="subtitle">SPY / QQQ 0DTE options &middot; EMA(9/21) + VWAP + volume strategy</div>

    ${trades.length > 0 ? `
    <div class="legend">
      <div class="legend-item"><span class="swatch" style="background:var(--good)"></span> Win</div>
      <div class="legend-item"><span class="swatch" style="background:var(--critical)"></span> Loss</div>
    </div>
    <div class="chart-scroll">
      <div class="chart">
        ${bars}
      </div>
    </div>
    ` : `<div class="empty-state">No trades were taken today.</div>`}

    <div class="summary">
      <div class="summary-item">
        <span class="summary-label">Winning trades</span>
        <span class="summary-value text-good">${wins.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Losing trades</span>
        <span class="summary-value text-critical">${losses.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total trades</span>
        <span class="summary-value">${trades.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total P&amp;L</span>
        <span class="summary-value ${totalPnL >= 0 ? 'text-good' : 'text-critical'}">${fmtMoney(totalPnL)}</span>
      </div>
    </div>

    ${trades.length > 0 ? `
    <details>
      <summary>View trade table</summary>
      <table>
        <thead>
          <tr><th>#</th><th>Contract</th><th>Type</th><th>Qty</th><th>Entry</th><th>Entry time</th><th>Exit time</th><th>Exit reason</th><th>P&amp;L</th></tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </details>` : ''}
  </div>
</div>
</body>
</html>`;
}

function main() {
  const events = loadEvents();
  const trades = buildTrades(events);
  const dateLabel = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const html = buildHTML(trades, dateLabel);

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = path.join(REPORTS_DIR, `${dateLabel}.html`);
  fs.writeFileSync(outPath, html);
  console.log('Report written to', outPath);
  console.log('Trades:', trades.length, 'Total P&L:', trades.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2));
}

main();
