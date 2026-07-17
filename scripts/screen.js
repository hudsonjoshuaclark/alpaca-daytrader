// CLI entry point for the daily screener. See lib/screener.js for the actual logic —
// runner.js also calls that directly each morning so the universe refreshes automatically.
const { runScreen } = require('../lib/screener');

runScreen({ verbose: true })
  .then((result) => console.log('\nSelected universe for', result.date, ':', result.symbols))
  .catch((e) => console.error('FAIL', e.message, e.stack));
