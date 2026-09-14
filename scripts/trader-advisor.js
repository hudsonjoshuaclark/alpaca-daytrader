// Gathers free retail-attention/sentiment signals for the bot's trading universe and
// writes a dated JSON snapshot for the AGENT-ADVISOR.md agent (invoked by
// scripts/trader-advisor.ps1) to read and turn into a short written report. This script
// only reads external data and writes to logs/ — it never touches the account or config.
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const watchlist = require('../lib/watchlist');
const { gatherSignals } = require('../lib/traderSignals');

async function main() {
  // Union of the actually-traded universe and the broader screened watchlist, so a name
  // that's trending but not currently in UNIVERSE still shows up for context.
  const symbols = Array.from(new Set([...config.UNIVERSE, ...watchlist]));
  const signals = await gatherSignals(symbols, { topN: 8 });

  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `trader-signals-${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(signals, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(`Trending-in-universe: ${signals.trendingInUniverse.map((s) => s.symbol).join(', ') || '(none)'}`);
}

main().catch((e) => {
  console.error('trader-advisor.js failed:', e.message);
  process.exit(1);
});
