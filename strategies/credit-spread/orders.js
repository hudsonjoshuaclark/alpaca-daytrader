const client = require('./alpacaClient');

function roundTick(price) {
  const tick = price >= 3 ? 0.05 : 0.01;
  return Math.round(price / tick) * tick;
}

// Opens a put credit spread: sell the short (higher-strike, closer-to-money) put, buy the
// long (lower-strike, further-OTM) protective put, in one mleg order for a net CREDIT.
// legs: [{ symbol: shortPutSymbol, side: 'sell' }, { symbol: longPutSymbol, side: 'buy' }]
// netCreditLimit: positive $ amount, the minimum credit you're willing to accept.
async function openCreditSpreadLimit(legs, qty, netCreditLimit) {
  return client.trading('/v2/orders', {
    method: 'POST',
    body: {
      order_class: 'mleg',
      qty: String(qty),
      type: 'limit',
      limit_price: String(netCreditLimit.toFixed(2)),
      time_in_force: 'day',
      legs: legs.map((l) => ({
        symbol: l.symbol,
        ratio_qty: '1',
        side: l.side,
        position_intent: l.side === 'sell' ? 'sell_to_open' : 'buy_to_open',
      })),
    },
  });
}

// Closes the spread at market: buy back the short put, sell the long put.
async function closeCreditSpreadMarket(legs, qty) {
  return client.trading('/v2/orders', {
    method: 'POST',
    body: {
      order_class: 'mleg',
      qty: String(qty),
      type: 'market',
      time_in_force: 'day',
      legs: legs.map((l) => ({
        symbol: l.symbol,
        ratio_qty: '1',
        side: l.side === 'sell' ? 'buy' : 'sell', // reverse the entry side
        position_intent: l.side === 'sell' ? 'buy_to_close' : 'sell_to_close',
      })),
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
  roundTick, openCreditSpreadLimit, closeCreditSpreadMarket, closePositionMarket,
  getOrder, cancelOrder, getAllPositions, getAccount,
};
