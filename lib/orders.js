const client = require('./alpacaClient');
const cfg = require('./config');

// Rounds a limit price to the option tick (options under $3 tick in $0.01, $3+ in $0.05;
// use $0.01 everywhere — Alpaca accepts penny increments on penny-pilot names, and
// rounding down to $0.05 on others is handled by the API rejecting; keep $0.05 for >= $3).
function roundTick(price) {
  const tick = price >= 3 ? 0.05 : 0.01;
  return Math.round(price / tick) * tick;
}

// Entry as a marketable-ish limit at mid + 25% of the half-spread: pays a fraction of
// the spread instead of the whole thing (the old market orders crossed the full spread —
// on an 8% spread contract that's ~8% of premium round trip, a huge drag at this size).
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

// Vertical spread entry: single mleg limit order at the net debit.
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

// Exits go market: guaranteed out. The entry limit is where spread cost is saved;
// on exits, being stuck in a decaying option costs more than the half-spread.
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
        // reverse the entry side
        side: l.side === 'buy' ? 'sell' : 'buy',
        position_intent: l.side === 'buy' ? 'sell_to_close' : 'buy_to_close',
      })),
    },
  });
}

// Market-close an entire position by symbol (used for untracked leftovers at flatten time).
async function closePositionMarket(symbol) {
  return client.trading(`/v2/positions/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
}

async function getOrder(orderId) {
  return client.trading(`/v2/orders/${orderId}`);
}

async function cancelOrder(orderId) {
  return client.trading(`/v2/orders/${orderId}`, { method: 'DELETE' });
}

async function getPosition(optionSymbol) {
  try {
    return await client.trading(`/v2/positions/${encodeURIComponent(optionSymbol)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function getAllPositions() {
  return client.trading('/v2/positions');
}

async function getAccount() {
  return client.trading('/v2/account');
}

module.exports = {
  roundTick,
  entryLimitFromQuote,
  buyToOpenLimit,
  openSpreadLimit,
  sellToClose,
  closeSpreadMarket,
  getOrder,
  cancelOrder,
  closePositionMarket,
  getPosition,
  getAllPositions,
  getAccount,
};
