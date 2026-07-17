// Curated universe of liquid, optionable, historically high-volume/volatile stocks.
// Screened daily (see scripts/screen.js) rather than traded outright — this is the
// candidate pool, not the trading list.
module.exports = [
  // Mega-cap tech
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA',
  // Semis
  'AMD', 'AVGO', 'MU', 'SMCI', 'QCOM', 'INTC', 'ARM',
  // Software / high-beta momentum
  'CRM', 'ADBE', 'NOW', 'PLTR', 'SNOW', 'NET', 'CRWD', 'DDOG',
  // Fintech / payments
  'PYPL', 'XYZ', 'COIN', 'V', 'MA', 'SOFI', // XYZ = Block Inc, renamed from SQ Jan 2025
  // EV / auto
  'RIVN', 'LCID', 'F', 'GM', 'NIO',
  // Consumer / retail momentum
  'SHOP', 'ABNB', 'UBER', 'DASH',
  // Media
  'NFLX', 'DIS', 'WBD',
  // Biotech momentum
  'MRNA', 'NVAX',
  // High retail interest
  'GME', 'AMC',
  // Energy
  'XOM', 'CVX', 'OXY',
  // Banks
  'JPM', 'GS', 'BAC',
  // Travel / industrials
  'DAL', 'UAL', 'BA',
  // Crypto-adjacent equities
  'MSTR', 'MARA', 'RIOT',
];
