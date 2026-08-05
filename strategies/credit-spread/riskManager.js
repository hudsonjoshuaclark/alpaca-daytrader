// Risk/state management for the credit-spread strategy. Daily-reset state, like ORB-15 -
// 0DTE positions must be closed same day, there's no overnight carry the way overnight-
// drift/trader-mimicry have.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const STATE_FILE = path.join(__dirname, 'logs', 'daily-state.json');
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
  const today = todayET();
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.date === today) return state;
  }
  const fresh = { date: today, trades: 0, realizedPnL: 0, openTrades: [], tradedSymbols: [], dayEndLogged: false };
  saveState(fresh);
  return fresh;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function recordEntry(state, trade) {
  state.trades += 1;
  state.openTrades.push(trade);
  if (!state.tradedSymbols.includes(trade.underlying)) state.tradedSymbols.push(trade.underlying);
  saveState(state);
}

function removeTrade(state, orderId) {
  state.openTrades = state.openTrades.filter((t) => t.orderId !== orderId);
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
    g.pausedReason = `equity ${currentEquity.toFixed(2)} <= ${(cfg.PAUSE_DRAWDOWN_PCT * 100)}% drawdown floor ${floor.toFixed(2)} (initial capital ${g.initialCapital})`;
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
  if (state.tradedSymbols.includes(symbol)) reasons.push(`already traded ${symbol} today`);
  if (state.openTrades.length >= cfg.MAX_CONCURRENT_POSITIONS) reasons.push(`max concurrent positions (${cfg.MAX_CONCURRENT_POSITIONS}) reached`);
  const guardrail = checkAccountGuardrail(portfolioValue);
  if (guardrail.paused) reasons.push(`account paused for review: ${guardrail.reason}`);
  return { allowed: reasons.length === 0, reasons };
}

module.exports = {
  loadState, saveState, recordEntry, removeTrade, recordExit,
  checkAccountGuardrail, resetAccountGuardrail, canEnterNewTrade, nowET, todayET,
};
