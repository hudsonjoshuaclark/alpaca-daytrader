const client = require('./alpacaClient');

// Plain equity orders. Market on both legs, deliberately: the backtest measures the 15:55
// bar close in and the 09:35 bar close out, and a limit order that fails to fill simply
// removes the trade rather than improving it. The overnight-drift options bot uses passive
// limits and loses ~43% of its signals to expiry as a result - shares have no such excuse,
// the assumed 5bp round-trip cost in the backtest already pays for crossing the spread.
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
