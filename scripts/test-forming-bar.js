// Regression test for the still-forming-bar entry bug fixed in lib/marketData.js on
// 2026-08-30. Builds a synthetic ORB day whose breakout bar is the last element of the
// array — the position IEX's still-forming bar occupies — and asserts that
// computeORBSignal() only returns a signal once that bar's 5-minute window has actually
// elapsed. Before the fix the "is this bar fresh" guard tested only the upper bound, so a
// bar closing in the FUTURE produced a negative age and passed, and 64% of live entry
// orders were placed on provisional closes.
//
// Clock handling: computeORBSignal reads Date.now() for the freshness check but plain
// `new Date()` for the "is this bar from today" filter. Stubbing Date.now() alone
// therefore moves the test's notion of NOW without moving the session date, which is what
// lets a test run at 4am assert on a 10:30 ET bar. Bars are dated today so the day filter
// matches for real.
//
// Usage: node --env-file=.env scripts/test-forming-bar.js
const md = require('../lib/marketData');
const cfg = require('../lib/config');

const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ET wall-clock -> the UTC instant of that bar's OPEN. Probes the offset rather than
// hardcoding EDT/EST so the test does not break twice a year.
function etBarTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  let guess = new Date(`${todayET}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  for (let i = 0; i < 3; i++) {
    const shown = guess.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    const [sh, sm] = shown.split(':').map(Number);
    const drift = (h * 60 + m) - (sh * 60 + sm);
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift * 60 * 1000);
  }
  return guess;
}

const bar = (hhmm, o, h, l, c, v) => ({ t: etBarTime(hhmm).toISOString(), o, h, l, c, v });
const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// Opening range 09:30-09:45 is 100-102, so orMid is 101 and a close above 102 on the final
// bar is a bullish breakout. Volume is flat at 1000 except the breakout bar at 3000, so
// rvol is ~3.0, comfortably over ORB_RVOL_MIN.
function buildBars(breakoutHHMM) {
  // rollingAvgVolume needs VOLUME_LOOKBACK bars BEFORE the breakout bar, and a single
  // 09:30-10:30 session only supplies 13. Prepend yesterday's tail: computeORBSignal's
  // todayIdx filter ignores them for signal purposes, but the volume average spans the
  // whole array, which is exactly how the live bot sees it too.
  const bars = [];
  const yesterday = new Date(etBarTime('09:30').getTime() - 24 * 60 * 60 * 1000);
  for (let k = 0; k < cfg.VOLUME_LOOKBACK; k++) {
    bars.push({
      t: new Date(yesterday.getTime() + k * 5 * 60 * 1000).toISOString(),
      o: 101, h: 101.5, l: 100.5, c: 101, v: 1000,
    });
  }
  bars.push(
    bar('09:30', 100, 102, 100, 101, 1000),
    bar('09:35', 101, 102, 100, 101, 1000),
    bar('09:40', 101, 102, 100, 101, 1000),
  );
  let mins = 9 * 60 + 45;
  const breakoutMins = Number(breakoutHHMM.slice(0, 2)) * 60 + Number(breakoutHHMM.slice(3));
  // Quiet in-range bars up to the breakout, enough to satisfy VOLUME_LOOKBACK + 2.
  while (mins < breakoutMins) {
    bars.push(bar(toHHMM(mins), 101, 101.5, 100.5, 101, 1000));
    mins += 5;
  }
  bars.push(bar(breakoutHHMM, 101, 103.5, 101, 103, 3000));
  return bars;
}

// The breakout bar sits at 10:30-10:35 ET in every case; only NOW moves.
const BREAKOUT = '10:30';
const breakoutOpenMs = etBarTime(BREAKOUT).getTime();
const breakoutCloseMs = breakoutOpenMs + 5 * 60 * 1000;
const bars = buildBars(BREAKOUT);

// VOLUME_LOOKBACK + 2 bars must exist for the function to run at all.
if (bars.length < cfg.VOLUME_LOOKBACK + 2) {
  console.log(`FAIL: fixture only has ${bars.length} bars, need ${cfg.VOLUME_LOOKBACK + 2}`);
  process.exit(1);
}

const realNow = Date.now;
const at = (ms, fn) => { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } };

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); }
};

// 1. Mid-bar: the window is open, the 103 close is provisional. This is the bug.
const midBar = at(breakoutOpenMs + 4.5 * 60 * 1000, () => md.computeORBSignal(bars));
check('still-forming bar (4m30s into its window) produces NO signal', midBar === null);

// 2. One second before the close — still forming, still must be refused.
const justBefore = at(breakoutCloseMs - 1000, () => md.computeORBSignal(bars));
check('bar 1s before its close produces NO signal', justBefore === null);

// 3. Just after the close: the bar is final and fresh. This must still trade.
const justAfter = at(breakoutCloseMs + 5 * 1000, () => md.computeORBSignal(bars));
check('bar 5s after its close DOES produce a signal', justAfter !== null);
if (justAfter) {
  check('  direction is bullish (close 103 > orHigh 102)', justAfter.direction === 'bullish');
  check('  orMid is the 09:30-09:45 midpoint (101)', justAfter.orMid === 101);
  check('  rvol cleared ORB_RVOL_MIN', justAfter.rvol >= cfg.ORB_RVOL_MIN);
  check('  barTime is the breakout bar', justAfter.barTime === bars[bars.length - 1].t);
}

// 4. Inside the 6-minute freshness window, well after the close: still valid.
const fresh = at(breakoutCloseMs + 5 * 60 * 1000, () => md.computeORBSignal(bars));
check('bar 5 min after its close is still fresh enough to trade', fresh !== null);

// 5. The upper bound must survive the fix — a stale bar is still refused.
const stale = at(breakoutCloseMs + 20 * 60 * 1000, () => md.computeORBSignal(bars));
check('bar 20 min after its close produces NO signal (upper bound intact)', stale === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
