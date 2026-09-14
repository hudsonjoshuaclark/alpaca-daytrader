// Turning raw broker legs into the economic positions a human reasons about.
// Kept out of status-server.js so it can be unit-tested without starting the HTTP listener -
// the same reason lib/healthChecks.js exists. `closeGroupFor` is injected rather than
// imported so this module stays free of strategy config and credentials.

// OCC option symbol -> readable contract. "AMZN260819C00265000" becomes
// { underlying:'AMZN', expiry:'2026-08-19', type:'C', strike:265 }. The raw symbol is always
// kept alongside, because that is what the broker and the logs actually key on.
function parseOcc(symbol) {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol || '');
  if (!m) return null;
  return {
    underlying: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5],
    strike: parseInt(m[6], 10) / 1000,
  };
}

// Collapses raw broker legs into the economic positions a human actually reasons about.
//
// A vertical spread arrives from Alpaca as two independent rows, but closing one leg alone
// would leave a naked short - so the UI must never offer per-leg actions. closeGroupFor()
// is the same resolver /api/close uses server-side, which keeps the button and the endpoint
// agreeing by construction. Where the bot's own openTrades record covers a group, its
// metadata (direction, opening-range midpoint, entry time) is joined on so the position can
// be explained rather than merely listed.
function buildPositionGroups(closeGroupFor, strategyKey, positions, openTrades) {
  const byGroup = new Map();
  for (const p of positions || []) {
    const key = closeGroupFor(strategyKey, p.symbol).symbols.slice().sort().join('|');
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(p);
  }

  return [...byGroup.values()].map((legs) => {
    const parsed = legs.map((l) => ({ ...l, occ: parseOcc(l.symbol) }));
    const underlying = (parsed.find((l) => l.occ) || {}).occ?.underlying
      || parsed[0].symbol.replace(/\d.*$/, '');
    const tracked = (openTrades || []).find((t) => t.underlying === underlying) || null;
    const unrealizedPl = parsed.reduce((a, l) => a + (l.unrealizedPl || 0), 0);
    // Cost basis of the structure, so a % return means something for a spread rather than
    // being averaged across legs with opposite signs.
    const costBasis = tracked && tracked.entryDebit
      ? Math.abs(tracked.entryDebit) * 100 * (tracked.qty || 1)
      : parsed.reduce((a, l) => a + Math.abs((parseFloat(l.avgEntryPrice) || 0) * (parseInt(l.qty, 10) || 0) * 100), 0);

    // A one-line description of the structure: "AMZN 265C" or "QQQ 725/722 put spread".
    let label = underlying;
    const occs = parsed.map((l) => l.occ).filter(Boolean);
    if (occs.length === 1) {
      label = `${underlying} ${occs[0].strike}${occs[0].type}`;
    } else if (occs.length === 2 && occs[0].type === occs[1].type) {
      const strikes = occs.map((o) => o.strike).sort((a, b) => b - a);
      label = `${underlying} ${strikes[0]}/${strikes[1]} ${occs[0].type === 'P' ? 'put' : 'call'} spread`;
    }

    return {
      id: parsed.map((l) => l.symbol).sort().join('|'),
      underlying,
      label,
      expiry: occs.length ? occs[0].expiry : null,
      direction: tracked ? tracked.direction : null,
      orMid: tracked ? tracked.orMid : null,
      entryDebit: tracked ? tracked.entryDebit : null,
      openedAt: tracked ? tracked.enteredAt || tracked.barTime || null : null,
      qty: tracked ? tracked.qty : Math.abs(parseInt(parsed[0].qty, 10) || 0),
      unrealizedPl,
      unrealizedPlPct: costBasis > 0 ? (unrealizedPl / costBasis) * 100 : null,
      costBasis,
      // Every leg the close action will touch. The UI states this count explicitly before
      // the user confirms, so "close" never silently does more than it appears to.
      legs: parsed.map((l) => ({
        symbol: l.symbol,
        qty: l.qty,
        side: (parseInt(l.qty, 10) || 0) < 0 ? 'short' : 'long',
        avgEntryPrice: l.avgEntryPrice,
        currentPrice: l.currentPrice,
        unrealizedPl: l.unrealizedPl,
        strike: l.occ ? l.occ.strike : null,
        type: l.occ ? l.occ.type : null,
      })),
    };
  });
}


module.exports = { parseOcc, buildPositionGroups };
