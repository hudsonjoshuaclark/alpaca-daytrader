const client = require('./alpacaClient');

function roundTick(price) {
  const tick = price >= 3 ? 0.05 : 0.01;
  return Math.round(price / tick) * tick;
}

function entryLimitFromQuote(quote) {
  return roundTick(quote.mid + 0.25 * (quote.ask - quote.mid));
}

async function buyToOpenLimit(optionSymbol, qty, limitPrice) {
  return client.trading('/v2/orders', {
    method: 'POST',
    body: {
      symbol: optionSymbol,
      qty: String(qty),
      side: 'buy',
      type: 'limit',
      limit_price: String(limitPrice.toFixed(2)),
      time_in_force: 'day',
    },
  });
}

async function openSpreadLimit(legs, qty, netDebitLimit) {
  return client.trading('/v2/orders', {
    method: 'POST',
    body: {
      order_class: 'mleg',
      qty: String(qty),
      type: 'limit',
      limit_price: String(netDebitLimit.toFixed(2)),
      time_in_force: 'day',
      legs: legs.map((l) => ({
        symbol: l.symbol,
        ratio_qty: '1',
        side: l.side,
        position_intent: l.side === 'buy' ? 'buy_to_open' : 'sell_to_open',
      })),
    },
  });
}

async function closeSpreadMarket(legs, qty) {
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
        side: l.side === 'buy' ? 'sell' : 'buy',
        position_intent: l.side === 'buy' ? 'sell_to_close' : 'buy_to_close',
      })),
    },
  });
}

async function sellToClose(optionSymbol, qty) {
  return client.trading('/v2/orders', {
    method: 'POST',
    body: {
      symbol: optionSymbol,
      qty: String(qty),
      side: 'sell',
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
  roundTick, entryLimitFromQuote, buyToOpenLimit, openSpreadLimit, closeSpreadMarket,
  sellToClose, closePositionMarket, getOrder, cancelOrder, getAllPositions, getAccount,
};
