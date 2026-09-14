// Static 2026 macro-event calendar (FOMC decisions, CPI, NFP/Employment Situation).
// Pure data + lookup — no live network calls, nothing here changes runner.js behavior on
// its own. Sourced 2026-07-28 from federalreserve.gov/monetarypolicy/fomccalendars.htm and
// bls.gov/cpi + bls.gov employment-situation releases. NFP dates follow BLS's usual "first
// Friday of the month" pattern; H1 2026 saw irregular shifts from a government-shutdown
// data backlog (e.g. Jul NFP fell on Thu Jul 2, not Fri Jul 3, for the Jul 4 holiday; several
// early-2026 releases were explicitly "rescheduled"). Aug-Dec below use the confirmed Aug 7
// date and the standard rule for Sep-Dec — verify against bls.gov close to each date, since
// this list is not authoritative and needs a periodic refresh, ideally yearly.
//
// Deliberately NOT wired into runner.js yet — see scripts/sweep6-filters.js. The strategy's
// documented edge (BACKTEST-BASELINE.md / sweep5-options.js) is fat-tailed and driven by
// rare large-move days; macro-print days are plausible candidates for exactly those days,
// so blacking them out needs backtest evidence, not just industry-standard practice.
const EVENTS_2026 = [
  { type: 'FOMC', date: '2026-01-28' },
  { type: 'FOMC', date: '2026-03-18' },
  { type: 'FOMC', date: '2026-04-29' },
  { type: 'FOMC', date: '2026-06-17' },
  { type: 'FOMC', date: '2026-07-29' },
  { type: 'FOMC', date: '2026-09-16' },
  { type: 'FOMC', date: '2026-10-28' },
  { type: 'FOMC', date: '2026-12-09' },

  { type: 'CPI', date: '2026-01-13' },
  { type: 'CPI', date: '2026-02-13' },
  { type: 'CPI', date: '2026-03-11' },
  { type: 'CPI', date: '2026-04-10' },
  { type: 'CPI', date: '2026-05-12' },
  { type: 'CPI', date: '2026-06-10' },
  { type: 'CPI', date: '2026-07-14' },
  { type: 'CPI', date: '2026-08-12' },
  { type: 'CPI', date: '2026-09-11' },
  { type: 'CPI', date: '2026-10-14' },
  { type: 'CPI', date: '2026-11-10' },
  { type: 'CPI', date: '2026-12-10' },

  { type: 'NFP', date: '2026-01-02' },
  { type: 'NFP', date: '2026-02-11' },
  { type: 'NFP', date: '2026-03-06' },
  { type: 'NFP', date: '2026-04-03' },
  { type: 'NFP', date: '2026-05-08' },
  { type: 'NFP', date: '2026-06-05' },
  { type: 'NFP', date: '2026-07-02' },
  { type: 'NFP', date: '2026-08-07' },
  { type: 'NFP', date: '2026-09-04' },
  { type: 'NFP', date: '2026-10-02' },
  { type: 'NFP', date: '2026-11-06' },
  { type: 'NFP', date: '2026-12-04' },
];

function eventsOn(dayStr) {
  return EVENTS_2026.filter((e) => e.date === dayStr);
}

function isMacroDay(dayStr) {
  return eventsOn(dayStr).length > 0;
}

module.exports = { EVENTS_2026, eventsOn, isMacroDay };
