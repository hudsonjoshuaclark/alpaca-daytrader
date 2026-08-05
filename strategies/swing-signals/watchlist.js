// Own copy of ../../lib/watchlist.js, same isolation reasoning as the rest of this strategy.
// The RSI-pullback signal was validated (scripts/strategy-swing-sweep.js) against exactly
// this universe - changing it live would mean trading on an unvalidated symbol set.
module.exports = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA',
  'AMD', 'AVGO', 'MU', 'SMCI', 'QCOM', 'INTC', 'ARM',
  'CRM', 'ADBE', 'NOW', 'PLTR', 'SNOW', 'NET', 'CRWD', 'DDOG',
  'PYPL', 'XYZ', 'COIN', 'V', 'MA', 'SOFI',
  'RIVN', 'LCID', 'F', 'GM', 'NIO',
  'SHOP', 'ABNB', 'UBER', 'DASH',
  'NFLX', 'DIS', 'WBD',
  'MRNA', 'NVAX',
  'GME', 'AMC',
  'XOM', 'CVX', 'OXY',
  'JPM', 'GS', 'BAC',
  'DAL', 'UAL', 'BA',
  'MSTR', 'MARA', 'RIOT',
];
