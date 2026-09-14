// Alpaca client for the swing-signals strategy. The shared transport in
// ../../lib/httpClient.js holds no config or credentials of its own - binding it to THIS
// strategy's config here is what guarantees every request uses this strategy's own account,
// with zero chance of picking up another bot's credentials via a shared module.
const cfg = require('./config');
const { createAlpacaClient } = require('../../lib/httpClient');

module.exports = createAlpacaClient(cfg);
