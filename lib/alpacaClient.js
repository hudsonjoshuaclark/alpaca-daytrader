// Alpaca client for the ORB-15 bot, bound to lib/config.js (the root .env account).
// All request/retry behaviour lives in ./httpClient.js, which is shared by every bot;
// the binding here is what keeps this client on THIS account's credentials.
const cfg = require('./config');
const { createAlpacaClient } = require('./httpClient');

module.exports = createAlpacaClient(cfg);
