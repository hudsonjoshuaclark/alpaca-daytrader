// Smoke test for the ORB rebuild: module loads, signal computation on today's real
// bars (with Date.now frozen to a mid-morning moment), structure selection with live
// quotes, and risk gates.
//
// MUST run against throwaway state. The risk-gate checks below call canEnterNewTrade with
// a hardcoded $1000 portfolio value; that reaches checkAccountGuardrail(), which PERSISTS
// what it decides. Against the real account (worth more than $1000, high-water mark
// $2876) that call writes pausedForReview:true to logs/account-guardrails.json and stops
// the live bot from entering - silently, from a test whose entire job is to prove a change
// is safe. Confirmed by running it 2026-08-30. These two env vars must be set BEFORE
// lib/riskManager is required, since it resolves both paths at module load.
const os = require('os');
const fsx = require('fs');
const pathx = require('path');
const TMP = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'orb-smoke-'));
process.env.ORB_STATE_FILE = pathx.join(TMP, 'daily-state.json');
process.env.ORB_GUARDRAILS_FILE = pathx.join(TMP, 'account-guardrails.json');
process.on('exit', () => { try { fsx.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const cfg = require('C:/Users/hudso/alpaca-daytrader/lib/config');
const md = require('C:/Users/hudso/alpaca-daytrader/lib/marketData');
const contracts = require('C:/Users/hudso/alpaca-daytrader/lib/contracts');
const rm = require('C:/Users/hudso/alpaca-daytrader/lib/riskManager');
const orders = require('C:/Users/hudso/alpaca-daytrader/lib/orders');

async function main() {
  console.log('modules loaded ok');
  console.log('universe:', cfg.UNIVERSE.join(','));

  const bars = await md.getBars(['TSLA', 'SPY', 'META']);
  for (const sym of ['TSLA', 'SPY', 'META']) {
    console.log(`${sym}: ${bars[sym] ? bars[sym].length : 0} bars`);
  }

  // Replay today's TSLA bars minute by minute with a frozen clock to see whether/when
  // an ORB signal would have fired.
  const realNow = Date.now;
  for (const sym of ['TSLA', 'SPY', 'META']) {
    const all = bars[sym];
    let fired = null;
    for (let end = 25; end <= all.length; end++) {
      const slice = all.slice(0, end);
      const lastT = new Date(slice[slice.length - 1].t).getTime();
      Date.now = () => lastT + 5 * 60 * 1000 + 30 * 1000; // 30s after bar close
      const sig = md.computeORBSignal(slice);
      if (sig) { fired = sig; break; }
    }
    Date.now = realNow;
    console.log(`${sym} ORB replay:`, fired ? JSON.stringify(fired) : 'no signal today');
  }

  // structure selection with live (after-hours) quotes
  const lastTSLA = bars.TSLA[bars.TSLA.length - 1].c;
  const lastSPY = bars.SPY[bars.SPY.length - 1].c;
  const budget = 300;
  const s1 = await contracts.selectStructure('TSLA', 'bullish', lastTSLA, budget, md.getLatestOptionQuote);
  console.log('TSLA structure @$300 budget:', JSON.stringify(s1, null, 1));
  const s2 = await contracts.selectStructure('SPY', 'bearish', lastSPY, budget, md.getLatestOptionQuote);
  console.log('SPY structure @$300 budget:', JSON.stringify(s2, null, 1));

  // risk gates
  const state = rm.loadState();
  console.log('state:', JSON.stringify(state));
  console.log('gate(2 open):', JSON.stringify(rm.canEnterNewTrade(state, 1000, 2)));
  console.log('gate(0 open):', JSON.stringify(rm.canEnterNewTrade(state, 1000, 0)));
  console.log('budget @1000:', rm.tradeBudget(1000));
}

main().then(() => console.log('SMOKE OK')).catch((e) => { console.error('SMOKE FAIL', e.message, e.stack); process.exit(1); });
