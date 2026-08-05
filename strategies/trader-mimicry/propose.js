// Gathers the day's signals for the AGENT-TRADER-MIMICRY.md agent: real SEC Form 4
// insider open-market buys (strategies/trader-mimicry/insiderSignals.js) + StockTwits
// sentiment (reusing the main repo's lib/traderSignals.js - same free source as the
// trader-advisory agent) for each insider-buy candidate specifically. This script only
// reads external data and writes to logs/ - no account access, no order placement.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { gatherInsiderBuySignals } = require('./insiderSignals');
const { fetchSymbolSentiment } = require('../../lib/traderSignals');

async function main() {
  console.log('Fetching SEC Form 4 insider buy signals...');
  const insiderBuys = await gatherInsiderBuySignals({
    minValueUsd: cfg.MIN_INSIDER_TXN_VALUE_USD,
    maxFilings: 150,
  });
  console.log(`Found ${insiderBuys.length} genuine open-market insider buys >= $${cfg.MIN_INSIDER_TXN_VALUE_USD}.`);

  const topCandidates = insiderBuys.slice(0, 5);
  const sentiment = [];
  for (const c of topCandidates) {
    try {
      sentiment.push(await fetchSymbolSentiment(c.ticker));
    } catch (e) {
      sentiment.push({ symbol: c.ticker, error: e.message });
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const outFile = path.join(__dirname, 'logs', `signals-${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    insiderBuys,
    sentiment,
  }, null, 2));
  console.log(`Wrote ${outFile}`);
}

main().catch((e) => {
  console.error('propose.js signal-gathering failed:', e.message);
  process.exit(1);
});
