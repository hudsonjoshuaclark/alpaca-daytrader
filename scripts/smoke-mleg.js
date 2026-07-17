// One-shot validation that the paper account accepts mleg (multi-leg) option orders in
// the exact format lib/orders.js sends, then cancels immediately. Safe: tiny limit,
// canceled within the same run.
const md = require('../lib/marketData');
const contracts = require('../lib/contracts');
const orders = require('../lib/orders');

async function main() {
  const bars = await md.getBars(['TSLA']);
  const price = bars.TSLA[bars.TSLA.length - 1].c;
  const { structure, reason } = await contracts.selectStructure('TSLA', 'bullish', price, 400, md.getLatestOptionQuote);
  if (!structure || structure.kind !== 'spread') {
    console.log('could not build a spread to test:', reason || structure);
    return;
  }
  console.log('placing test mleg order:', structure.legs.map((l) => `${l.side} ${l.symbol}`).join(' / '));
  const placed = await orders.openSpreadLimit(structure.legs, 1, 0.05); // far below market — will not fill
  console.log('placed:', placed.id, 'status:', placed.status, 'class:', placed.order_class);
  await orders.cancelOrder(placed.id);
  const after = await orders.getOrder(placed.id);
  console.log('after cancel:', after.status);
}

main().then(() => console.log('MLEG OK')).catch((e) => console.error('MLEG FAIL', e.message));
