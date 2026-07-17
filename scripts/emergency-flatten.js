// Emergency failsafe: cancel every open order and market-close every position.
// Used by the watchdog/troubleshooting agent ONLY when the runner cannot be restored
// during market hours and positions would otherwise sit unmanaged (no stops firing).
// Usage: node --env-file=.env scripts/emergency-flatten.js
const client = require('../lib/alpacaClient');
const orders = require('../lib/orders');

async function main() {
  const open = await client.trading('/v2/orders', { params: { status: 'open', limit: 100 } });
  for (const o of open) {
    try {
      await orders.cancelOrder(o.id);
      console.log(`canceled order ${o.id} (${o.symbol})`);
    } catch (e) {
      console.error(`cancel ${o.id} failed: ${e.message}`);
    }
  }

  const positions = await orders.getAllPositions();
  if (positions.length === 0) {
    console.log('no open positions');
    return;
  }
  for (const pos of positions) {
    try {
      await orders.closePositionMarket(pos.symbol);
      console.log(`closed ${pos.symbol} qty=${pos.qty} unrealized_pl=${pos.unrealized_pl}`);
    } catch (e) {
      console.error(`close ${pos.symbol} failed: ${e.message}`);
    }
  }
}

main().then(() => console.log('EMERGENCY FLATTEN COMPLETE')).catch((e) => {
  console.error('EMERGENCY FLATTEN FAILED', e.message);
  process.exit(1);
});
