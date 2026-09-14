// Pure health-check predicates for the dashboard. Kept out of status-server.js so they can
// be tested directly - requiring status-server.js would start the HTTP listener. Time is
// injected rather than read from the clock, which is what makes these testable at all.

// Previous weekday, ignoring market holidays. Good enough for a staleness banner: a holiday
// produces one benign false positive a year, whereas the failure this catches (a scheduled
// run silently not happening) has already cost real sessions.
function prevWeekdayET(now = new Date()) {
  const d = new Date(now.getTime());
  do { d.setDate(d.getDate() - 1); }
  while (['Sat', 'Sun'].includes(d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })));
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Overnight-drift is two scheduled scripts, not a polling process, so it has no heartbeat
// and until 2026-08-13 no health signal of ANY kind on the dashboard. Its two runs are the
// only evidence it is alive: enter at 15:55 ET, exit at 09:35 ET the next session. On
// 2026-08-11 and 2026-08-12 neither ran (Modern Standby) and nothing surfaced it.
//
// state    - the bot's logs/state.json
// nowET    - "HH:MM" in ET
// today    - "YYYY-MM-DD" in ET
// weekday  - "Mon".."Sun" in ET
// prevDay  - previous weekday as "YYYY-MM-DD"
function checkOvernightStale(state, { nowET, today, weekday, prevDay }) {
  if (!state || ['Sat', 'Sun'].includes(weekday)) return null;
  const problems = [];
  const openCount = (state.openPositions || []).length;

  // The exit leg should have run by 09:35 ET today IF something is still recorded open.
  if (nowET >= '09:45' && state.lastExitDate !== today && openCount > 0) {
    problems.push(`exit run hasn't happened today (last: ${state.lastExitDate || 'never'}) but ${openCount} position(s) are still recorded open`);
  }
  // The enter leg should have run by 15:55 ET today.
  if (nowET >= '16:05' && state.lastEnterDate !== today) {
    problems.push(`enter run hasn't happened today (last: ${state.lastEnterDate || 'never'})`);
  }
  // Before today's entry window, the previous session should still be the last recorded run.
  if (nowET < '15:55' && state.lastEnterDate !== today && state.lastEnterDate !== prevDay) {
    problems.push(`last enter run was ${state.lastEnterDate || 'never'}, expected ${prevDay} — a session was skipped`);
  }
  if (!problems.length) return null;
  return { missed: true, reason: `Overnight Drift: ${problems.join('; ')}. Scheduled tasks don't run while the machine is in Modern Standby.` };
}

// Should the dashboard flag that today's intraday flatten never ran?
//
// Pure so it can be tested in both directions. An alert that never fires is worse than no
// alert, and an alert that fires wrongly is worse still - an earlier attempt at this used
// Windows Kernel-Power 506/507 events and reported a 2424-minute outage on a day the bots
// demonstrably traded all afternoon, because under Modern Standby those events mean
// "entered low-power idle", not "stopped". This version consumes only direct evidence:
// whether the bot's own flatten path wrote its DAY_END record today.
//
//   weekday   - "Mon".."Sun" in ET
//   today     - "YYYY-MM-DD" in ET
//   nowET     - "HH:MM" in ET
//   flattenAt - "HH:MM" in ET, the bot's configured flatten time
//   isHoliday - market holiday
//   ranToday  - did a DAY_END event appear in the bot's log with today's ET date
function shouldFlagMissedFlatten({ weekday, today, nowET, flattenAt, isHoliday, ranToday }) {
  if (['Sat', 'Sun'].includes(weekday)) return false;
  if (isHoliday) return false;
  if (ranToday) return false;
  return nowET >= overdueAfter(flattenAt);
}

// flattenAt + 20 minutes of grace: the flatten fires on a polling tick, and a broker retry
// can push it a little past the configured minute. Complaining at 15:46 would be noise.
function overdueAfter(flattenAt) {
  const [h, m] = flattenAt.split(':').map(Number);
  const total = h * 60 + m + 20;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

module.exports = { prevWeekdayET, checkOvernightStale, shouldFlagMissedFlatten, overdueAfter };
