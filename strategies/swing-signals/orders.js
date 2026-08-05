const client = require('./alpacaClient');

// Plain equity orders - materially simpler than the options bots, no contract selection,
// no multi-leg structures.
async function openMarketOrder(symbol, qty, side) {
  return client.trading('/v2/orders', {
    method: 'POST',
    body: {
      symbol,
      qty: String(qty),
      side,
      type: 'market',
      time_in_force: 'day',
    },
  });
}

async function closePositionMarket(symbol) {
  return client.trading(`/v2/positions/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
}

async function getOrder(orderId) {
  return client.trading(`/v2/orders/${orderId}`);
}

async function cancelOrder(orderId) {
  return client.trading(`/v2/orders/${orderId}`, { method: 'DELETE' });
}

async function getAllPositions() {
  return client.trading('/v2/positions');
}

async function getAccount() {
  return client.trading('/v2/account');
}

module.exports = {
  openMarketOrder, closePositionMarket, getOrder, cancelOrder, getAllPositions, getAccount,
};
