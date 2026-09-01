const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { todayET } = require('./contracts');

// Both paths are env-overridable so a test can be pointed at throwaway files. This is not
// decoration: scripts/smoke.js calls canEnterNewTrade(state, 1000, ...) with a HARDCODED
// $1000 portfolio value, which reaches checkAccountGuardrail() and, on a real account
// worth more than that, WRITES pausedForReview:true to the live guardrail file. It went
// unnoticed while the floor was anchored to initialCapital 1000 (the fake $1000 sat just
// above the $650 floor), and became live the moment the floor started trailing a $2876
// high-water mark. AGENT-REVIEW.md step 6 tells the nightly agent to run smoke.js after
// ANY code change, so the verification step would have silently paused trading.
const STATE_FILE = process.env.ORB_STATE_FILE || path.join(__dirname, '..', 'logs', 'daily-state.json');
const GUARDRAILS_FILE = process.env.ORB_GUARDRAILS_FILE || path.join(__dirname, '..', 'logs', 'account-guardrails.json');

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

// Persistent (NOT daily-reset) guardrail: pauses all new entries on a large drawdown.
// Does NOT auto-resume once paused — clearing pausedForReview is a deliberate human
// decision after a big drawdown.
//
// 2026-08-30: the floor was anchored to `initialCapital`, a number written ONCE the first
// time the guardrail ran and never updated again. logs/account-guardrails.json still held
// initialCapital 1000 from the 2026-08-03 account reset, so the floor sat at $650 while
// equity ran up to $2876 and back down to $2252 — a 21.7% peak-to-trough drawdown that
// the breaker was structurally incapable of seeing, and it would have taken a further
// -71% to fire. A static anchor only measures drawdown correctly on the day it is set;
// every day after that it measures return-since-inception instead. The floor now trails a
// high-water mark, which is what PAUSE_DRAWDOWN_PCT was always documented to mean
// ("pause everything if equity falls 35% below") and is the only version that keeps
// working after the account has moved. initialCapital is retained for reporting only.
function loadGuardrails() {
  if (fs.existsSync(GUARDRAILS_FILE)) {
    const g = JSON.parse(fs.readFileSync(GUARDRAILS_FILE, 'utf8'));
    // Migration for files written before peakEquity existed: seed the high-water mark
    // from initialCapital so a pre-existing account does not start with a null peak.
    if (g.peakEquity === undefined) g.peakEquity = g.initialCapital;
    return g;
  }
  const fresh = {
    initialCapital: null,
    peakEquity: null,
    pausedForReview: false,
    pausedReason: null,
    pausedAt: null,
  };
  fs.writeFileSync(GUARDRAILS_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

function saveGuardrails(g) {
  fs.writeFileSync(GUARDRAILS_FILE, JSON.stringify(g, null, 2));
}

function checkAccountGuardrail(currentEquity) {
  const g = loadGuardrails();
  if (g.pausedForReview) return { paused: true, reason: g.pausedReason };
  if (!Number.isFinite(currentEquity) || currentEquity <= 0) {
    // A bad equity read must not be able to move the high-water mark or trip the pause.
    return { paused: false, reason: null };
  }

  let dirty = false;
  if (g.initialCapital === null) {
    g.initialCapital = currentEquity;
    dirty = true;
  }
  // The mark only ever ratchets up; this is what makes the floor a drawdown floor.
  if (g.peakEquity === null || g.peakEquity === undefined || currentEquity > g.peakEquity) {
    g.peakEquity = currentEquity;
    dirty = true;
  }
  if (dirty) saveGuardrails(g);

  const floor = g.peakEquity * (1 - cfg.PAUSE_DRAWDOWN_PCT);
  if (currentEquity <= floor) {
    g.pausedForReview = true;
    g.pausedReason = `equity ${currentEquity.toFixed(2)} <= ${cfg.PAUSE_DRAWDOWN_PCT * 100}% drawdown floor ${floor.toFixed(2)} (peak equity ${g.peakEquity.toFixed(2)}, initial capital ${g.initialCapital})`;
    g.pausedAt = new Date().toISOString();
    saveGuardrails(g);
    return { paused: true, reason: g.pausedReason };
  }
  return { paused: false, reason: null };
}

function resetAccountGuardrail(newInitialCapital) {
  const g = {
    initialCapital: newInitialCapital ?? null,
    peakEquity: newInitialCapital ?? null,
    pausedForReview: false,
    pausedReason: null,
    pausedAt: null,
  };
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
