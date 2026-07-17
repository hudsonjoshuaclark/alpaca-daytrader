const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { todayET } = require('./contracts');

const STATE_FILE = path.join(__dirname, '..', 'logs', 'daily-state.json');
const GUARDRAILS_FILE = path.join(__dirname, '..', 'logs', 'account-guardrails.json');

function nowET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour').value;
  const m = parts.find((p) => p.type === 'minute').value;
  return `${h}:${m}`;
}

// Daily state. openTrades entries carry everything needed to manage the position:
// { underlying, kind: 'single'|'spread', legs: [{symbol, side}], qty, direction,
//   orMid, entryDebit, orderId, status: 'pending'|'open', enteredAt }
// tradedUnderlyings enforces the backtested one-ORB-attempt-per-symbol-per-day rule.
function loadState() {
  const today = todayET();
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.date === today) {
      // migrate pre-ORB schema written earlier the same day
      if (!Array.isArray(state.openTrades)) state.openTrades = [];
      if (!Array.isArray(state.tradedUnderlyings)) state.tradedUnderlyings = [];
      return state;
    }
  }
  const fresh = {
    date: today,
    trades: 0,
    realizedPnL: 0,
    startEquity: null,
    openTrades: [],
    tradedUnderlyings: [],
    dayEndLogged: false,
  };
  saveState(fresh);
  return fresh;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function recordEntry(state, trade) {
  state.trades += 1;
  state.openTrades.push(trade);
  if (!state.tradedUnderlyings.includes(trade.underlying)) {
    state.tradedUnderlyings.push(trade.underlying);
  }
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

// Persistent (NOT daily-reset) guardrail: pauses all new entries if equity ever falls
// too far below initial capital. Does NOT auto-resume once paused — clearing
// pausedForReview is a deliberate human decision after a big drawdown.
function loadGuardrails() {
  if (fs.existsSync(GUARDRAILS_FILE)) {
    return JSON.parse(fs.readFileSync(GUARDRAILS_FILE, 'utf8'));
  }
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

// openTradeCount counts both pending entry orders and filled positions — a pending
// limit order reserves its concurrency slot until it fills or is canceled.
function canEnterNewTrade(state, portfolioValue, openTradeCount) {
  const reasons = [];
  if (nowET() >= cfg.ORB_ENTRY_CUTOFF) reasons.push(`past ORB entry cutoff ${cfg.ORB_ENTRY_CUTOFF} ET`);

  if (cfg.SMALL_ACCOUNT_MODE) {
    if (openTradeCount >= cfg.MAX_CONCURRENT_POSITIONS) {
      reasons.push(`max concurrent positions (${cfg.MAX_CONCURRENT_POSITIONS}) reached`);
    }
    if (state.startEquity && state.realizedPnL <= -state.startEquity * cfg.DAILY_LOSS_STOP_PCT) {
      reasons.push(`daily loss stop (${cfg.DAILY_LOSS_STOP_PCT * 100}% of day-start equity) hit`);
    }
    const guardrail = checkAccountGuardrail(portfolioValue);
    if (guardrail.paused) reasons.push(`account paused for review: ${guardrail.reason}`);
  } else {
    if (state.startEquity && state.realizedPnL <= -state.startEquity * cfg.MAX_DAILY_LOSS_PCT) {
      reasons.push(`daily loss limit (${cfg.MAX_DAILY_LOSS_PCT * 100}%) hit`);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

function shouldForceFlatten() {
  return nowET() >= cfg.FORCE_FLATTEN_AT;
}

// Premium budget for the next trade.
function tradeBudget(portfolioValue) {
  if (cfg.SMALL_ACCOUNT_MODE) return portfolioValue * cfg.RISK_PCT_PER_TRADE;
  return portfolioValue * cfg.RISK_PER_TRADE_PCT;
}

module.exports = {
  loadState,
  saveState,
  recordEntry,
  recordExit,
  removeTrade,
  canEnterNewTrade,
  shouldForceFlatten,
  tradeBudget,
  nowET,
  checkAccountGuardrail,
  resetAccountGuardrail,
};
