// Tests for the ORB-15 operator console (status.html + /api/status).
//
// The invariant that matters: a multi-leg option structure must surface as ONE position with
// ONE close action. Offering a per-leg close would let a click buy back the protective long
// of a spread and leave a naked short. The bot is flat most of the time, so this cannot be
// observed live - it is exercised here with synthetic positions instead.
//
// Run: node scripts/test-dashboard-2026-08-19.js
const fs = require('fs');
const path = require('path');
const { parseOcc, buildPositionGroups } = require('../lib/positions');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

// --- 1. OCC symbol parsing ---------------------------------------------------------------
console.log('\n[1] OCC contract parsing');
const c = parseOcc('AMZN260819C00265000');
check('underlying', c && c.underlying === 'AMZN');
check('expiry', c && c.expiry === '2026-08-19', c && c.expiry);
check('type', c && c.type === 'C');
check('strike is dollars, not thousandths', c && c.strike === 265, c && c.strike);
check('fractional strike survives', parseOcc('SPY260813P00768500').strike === 768.5);
check('non-option symbol returns null', parseOcc('MARA') === null);
check('garbage returns null rather than throwing', parseOcc('') === null);

// --- 2. spread grouping ------------------------------------------------------------------
console.log('\n[2] multi-leg grouping — one position, one action');
// A real vertical: long the 495 call, short the 500 call, entered for a $2.15 debit.
const SPREAD = ['AMD260814C00495000', 'AMD260814C00500000'];
const positions = [
  { symbol: SPREAD[0], qty: '1', avgEntryPrice: '5.10', currentPrice: '5.60', unrealizedPl: 50 },
  { symbol: SPREAD[1], qty: '-1', avgEntryPrice: '2.95', currentPrice: '3.20', unrealizedPl: -25 },
];
const openTrades = [{ underlying: 'AMD', direction: 'bullish', orMid: 494.2, entryDebit: 2.15, qty: 1,
  legs: [{ symbol: SPREAD[0] }, { symbol: SPREAD[1] }] }];
// Stand-in resolver with the same contract as the server's: any leg resolves to all legs.
const resolver = (key, symbol) => (SPREAD.includes(symbol) ? { symbols: SPREAD } : { symbols: [symbol] });

const groups = buildPositionGroups(resolver, 'orb15', positions, openTrades);
check('two legs collapse into ONE position', groups.length === 1, `got ${groups.length}`);
const g = groups[0];
check('both legs retained inside it', g.legs.length === 2);
check('reads as a spread, not a raw symbol', g.label === 'AMD 500/495 call spread', g.label);
check('direction joined from the bot\'s own record', g.direction === 'bullish');
check('opening-range midpoint joined (this is the stop)', g.orMid === 494.2);
check('P&L is the NET of both legs', g.unrealizedPl === 25, `got ${g.unrealizedPl}`);
check('cost basis uses the structure debit, not summed legs', g.costBasis === 215, `got ${g.costBasis}`);
check('return % is against the structure', Math.abs(g.unrealizedPlPct - (25 / 215) * 100) < 1e-9);
check('short leg identified', g.legs.find((l) => l.symbol === SPREAD[1]).side === 'short');
check('long leg identified', g.legs.find((l) => l.symbol === SPREAD[0]).side === 'long');
check('strikes parsed onto legs', g.legs.every((l) => typeof l.strike === 'number'));

// --- 3. singles and unknowns -------------------------------------------------------------
console.log('\n[3] single-leg and untracked positions');
const single = buildPositionGroups((k, s) => ({ symbols: [s] }), 'orb15',
  [{ symbol: 'PLTR260814C00175000', qty: '2', avgEntryPrice: '2.72', currentPrice: '2.60', unrealizedPl: -24 }],
  [{ underlying: 'PLTR', direction: 'bullish', orMid: 174.15, entryDebit: 2.72, qty: 2 }]);
check('single option is one group', single.length === 1);
check('single reads as strike + type', single[0].label === 'PLTR 175C', single[0].label);
check('cost basis for qty 2', single[0].costBasis === 544, `got ${single[0].costBasis}`);

// An orphan leg the bot is not tracking must still be closeable, on its own.
const orphan = buildPositionGroups((k, s) => ({ symbols: [s] }), 'orb15',
  [{ symbol: 'NVDA260807C00220000', qty: '1', avgEntryPrice: '1.13', currentPrice: '1.35', unrealizedPl: 22 }], []);
check('untracked position still forms a group', orphan.length === 1);
check('untracked has no invented metadata', orphan[0].direction === null && orphan[0].orMid === null);
// float tolerance: 1.13*100 is 112.99999999999999 in IEEE754. Display rounds it, so the
// assertion should too rather than pretending binary floats are exact.
check('untracked falls back to leg cost basis', Math.abs(orphan[0].costBasis - 113) < 1e-6, `got ${orphan[0].costBasis}`);

// Plain shares (no OCC) must not crash the parser.
const shares = buildPositionGroups((k, s) => ({ symbols: [s] }), 'x',
  [{ symbol: 'MARA', qty: '15', avgEntryPrice: '9.71', currentPrice: '9.68', unrealizedPl: -0.45 }], []);
check('plain equity symbol handled', shares.length === 1 && shares[0].underlying === 'MARA');

check('flat account yields no groups', buildPositionGroups(resolver, 'orb15', [], []).length === 0);

// --- 4. the page itself ------------------------------------------------------------------
console.log('\n[4] status.html contract');
const html = fs.readFileSync(path.join(__dirname, '..', 'status.html'), 'utf8');
check('PAPER badge is present and unmissable', /class="chip paper">PAPER</.test(html));
check('close is two-step (confirm before submit)', /askClose\(/.test(html) && /Submit close order/.test(html));
check('confirmation enumerates every leg', /g\.legs\.map\(\(l\) => '<li>'/.test(html));
check('close posts the strategy explicitly', /strategy: 'orb15'/.test(html));
check('stale data disables close controls', /stale \|\| closeInFlight \? 'disabled'/.test(html));
check('never optimistically removes a position', /Never optimistically drop the row/.test(html));
check('refresh cannot clobber an open confirmation', /if \(confirming \|\| closeInFlight\) return/.test(html));
check('holdings chart plots the underlying', /function sparkline/.test(html));
check('chart draws the OR midpoint stop', /OR mid/.test(html));
check('equity curve present', /function renderEquity/.test(html));
check('flat state is explained, not blank', /Flat — no open positions/.test(html));
check('raw log demoted to diagnostics', /Technical details/.test(html));
check('tabular numerals for money', /tabular-nums/.test(html));
check('no external asset requests', !/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/lang="en"/, '')));
check('escapes interpolated values', /const esc = /.test(html) && /esc\(g\.label\)/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
