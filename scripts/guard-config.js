// Post-review guard: enforces that the nightly review agent (or anyone else) has not
// changed the locked risk caps or broken config syntax. On violation, restores
// lib/config.js from git HEAD and exits 1 so the wrapper knows to restart the runner.
// The lock file is the single place a HUMAN changes risk deliberately: update the lock
// AND config together, then commit both.
const { execSync } = require('child_process');
const path = require('path');
const locked = require('./risk-caps.lock.json');

const REPO = path.join(__dirname, '..');

function fail(reason) {
  console.error(`GUARD VIOLATION: ${reason}`);
  console.error('Restoring lib/config.js from git HEAD.');
  execSync('git checkout -- lib/config.js', { cwd: REPO });
  process.exit(1);
}

let cfg;
try {
  // eslint-disable-next-line global-require
  cfg = require('../lib/config');
} catch (e) {
  fail(`lib/config.js failed to load: ${e.message}`);
}

for (const [key, value] of Object.entries(locked)) {
  if (cfg[key] !== value) {
    fail(`${key} is ${cfg[key]}, locked at ${value}`);
  }
}

if (cfg.LIVE_MODE) {
  fail('LIVE_MODE is true — this bot must stay on the paper endpoint');
}

console.log('guard ok: risk caps intact, paper endpoint confirmed');
