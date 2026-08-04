// Ratcheting stop/take-profit levels — the "variable stop loss" system.
//
// Instead of closing the trade when it reaches the take-profit, hitting the target
// ADVANCES the trade one rung: the old stop/target pair is thrown away and a new, higher
// pair replaces it. Nothing about a rung ever closes a trade — only the stop does (or one
// of the bot's pre-existing exit rules). That's what makes the upside uncapped while the
// downside stays capped at one stop-distance below the last target actually reached.
//
// Every level is a fraction of the ENTRY price and is measured off entry, never off the
// current price. That means a level can be recomputed from the entry fill and the rung
// number alone, and a level can never drift downward:
//
//   rung n:   target = (n + 1) * step
//             stop   = n * step - stopDistance
//
//   step 2.0%, stopDistance 1.5%:
//     rung 0    stop -1.5%    target +2.0%
//     rung 1    stop +0.5%    target +4.0%   <- first rung that locks in a profit
//     rung 2    stop +2.5%    target +6.0%
//
// Note rung 0 reproduces a plain fixed stop/target exactly, so switching a bot onto this
// module changes nothing until the first target is reached.
//
// Pure math: no I/O, no config, and deliberately zero requires, so the live bots (which
// each load their own isolated account config) and the backtest sweeps can all share one
// definition of where the levels sit.

const DEFAULT_MAX_RUNGS = 100;

function levelsForRung(rung, step, stopDistance) {
  return {
    stop: rung * step - stopDistance,
    target: (rung + 1) * step,
  };
}

// The highest rung justified by `gain` (a fraction off entry, e.g. 0.021 for +2.1%).
// Never moves down — a ratchet only ever tightens — and jumps straight to the correct rung
// when a single poll spans several of them, since a gap can clear two targets before the
// bot ever observes a price in between. maxRungs bounds it so one bad quote can't produce
// absurd levels.
function rungFor(currentRung, gain, step, maxRungs = DEFAULT_MAX_RUNGS) {
  if (!(step > 0) || !(gain > 0)) return currentRung;
  return Math.max(currentRung, Math.min(Math.floor(gain / step), maxRungs));
}

// One evaluation pass for an open trade.
//
//   gain          current profit as a fraction of entry (Alpaca's unrealized_plpc for
//                 shares; pl / cost-basis for an option premium)
//   minStopRung   the first rung whose stop is allowed to fire. 0 means this module owns
//                 the stop outright. 1 leaves rung 0 alone, which is how a bot that already
//                 has its own validated stop bolts on the profit-locking part without
//                 altering the risk it takes on a trade that never runs.
//
// Returns { rung, advanced, stopped, stop, target }: `advanced` means it ratcheted on this
// pass (persist the new rung and log it), `stopped` means the live rung's stop is breached
// (close the trade). The two can never both be true — advancing to rung n requires
// gain >= n*step, and that rung's stop sits a full stopDistance below n*step.
function evaluate({ rung = 0, gain, step, stopDistance, maxRungs = DEFAULT_MAX_RUNGS, minStopRung = 0 }) {
  const nextRung = rungFor(rung, gain, step, maxRungs);
  const { stop, target } = levelsForRung(nextRung, step, stopDistance);
  return {
    rung: nextRung,
    advanced: nextRung > rung,
    stopped: nextRung >= minStopRung && gain <= stop,
    stop,
    target,
  };
}

module.exports = { DEFAULT_MAX_RUNGS, levelsForRung, rungFor, evaluate };
