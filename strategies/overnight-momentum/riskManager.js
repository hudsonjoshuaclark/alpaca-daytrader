// Risk/state management for overnight-momentum.
//
// State is PERSISTENT, not daily-reset. This is the one structural difference from
// swing-signals (whose riskManager this replaces): positions are opened at 15:55 and held
// through the night, so a daily reset would orphan every open position at midnight. Modelled
// on strategies/overnight-drift/riskManager.js, which carries positions the same way.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const STATE_FILE = path.join(__dirname, 'logs', 'state.json');
const GUARDRAILS_FILE = path.join(__dirname, 'logs', 'account-guardrails.json');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function nowET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour').value;
  const m = parts.find((p) => p.type === 'minute').value;
  return `${h}:${m}`;
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const fresh = {
    openPositions: [], lastEnterDate: null, lastExitDate: null,
    realizedPnL: 0, trades: 0, startEquity: null,
  };
  saveState(fresh);
  return fresh;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function recordEntry(state, trade) {
  state.trades += 1;
  state.openPositions.push(trade);
  saveState(state);
}

function removeTrade(state, orderId) {
  state.openPositions = state.openPositions.filter((t) => t.orderId !== orderId);
  saveState(state);
}

function recordExit(state, orderId, pnl) {
  state.realizedPnL += pnl;
  removeTrade(state, orderId);
}

function loadGuardrails() {
  if (fs.existsSync(GUARDRAILS_FILE)) return JSON.parse(fs.readFileSync(GUARDRAILS_FILE, 'utf8'));
  const fresh = { initialCapital: null, pausedForReview: false, pausedReason: null, pausedAt: null };
  fs.writeFileSync(GUARDRAILS_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

function saveGuardrails(g) {
  fs.writeFileSync(GUARDRAILS_FILE, JSON.stringify(g, null, 2));
}

// Persistent (NOT daily-reset) guardrail: pauses all new entries if equity ever falls too
// far below initial capital. Does NOT auto-resume - clearing pausedForReview is a deliberate
// human decision, same rule every other bot in this project follows.
function checkAccountGuardrail(currentEquity) {
  const g = loadGuardrails();
  if (g.initialCapital === null) {
    g.initialCapital = currentEquity;
    saveGuardrails(g);
  }
  if (g.pausedForReview) return { paused: true, reason: g.pausedReason };

  const floor = g.initialCapital * (1 - cfg.PAUSE_DRAWDOWN_PCT);
  if (currentEquity <= floor) {
    g.pausedForReview = true;
    g.pausedReason = `equity ${currentEquity.toFixed(2)} <= ${cfg.PAUSE_DRAWDOWN_PCT * 100}% drawdown floor ${floor.toFixed(2)} (initial capital ${g.initialCapital})`;
    g.pausedAt = new Date().toISOString();
    saveGuardrails(g);
    return { paused: true, reason: g.pausedReason };
  }
  return { paused: false, reason: null };
}

function resetAccountGuardrail(newInitialCapital) {
  const g = { initialCapital: newInitialCapital ?? null, pausedForReview: false, pausedReason: null, pausedAt: null };
  saveGuardrails(g);
  return g;
}

function canEnterNewTrade(state, portfolioValue, symbol) {
  const reasons = [];
  if (state.openPositions.some((t) => t.symbol === symbol)) reasons.push(`already holding ${symbol}`);
  if (state.openPositions.length >= cfg.MAX_CONCURRENT_POSITIONS) {
    reasons.push(`max concurrent positions (${cfg.MAX_CONCURRENT_POSITIONS}) reached`);
  }
  const guardrail = checkAccountGuardrail(portfolioValue);
  if (guardrail.paused) reasons.push(`account paused for review: ${guardrail.reason}`);
  return { allowed: reasons.length === 0, reasons };
}

function tradeBudget(portfolioValue) {
  return portfolioValue * cfg.RISK_PCT_PER_TRADE;
}

module.exports = {
  loadState, saveState, recordEntry, removeTrade, recordExit,
  checkAccountGuardrail, resetAccountGuardrail, canEnterNewTrade, tradeBudget,
  nowET, todayET,
};
