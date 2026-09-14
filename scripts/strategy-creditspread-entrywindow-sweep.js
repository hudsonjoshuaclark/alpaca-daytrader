// Can the 0DTE put-credit-spread bot make SEVERAL trades a day instead of one?
//
// WHY THIS EXISTS. credit-spread currently averages 0.57 trades/day. That is not a filter
// being too tight - it is structural: SYMBOLS is ['SPY','QQQ'], ENTRY_WINDOW is 09:35-10:00,
// and it takes one position per symbol per day, so the ceiling is 2/day and it misses about
// half of those on leg spread width. The only ways to raise it are more symbols or more
// entry windows.
//
// scripts/strategy-creditspread-sweep.js - the study that justified deploying this bot
// (n=247, 71.7% win, +168bp) - enters at `shortC.bars[0].o`, the FIRST BAR OF THE DAY, once
// per symbol per day. So there is no evidence at all about a second entry at 11:00 or 14:00.
// That is a genuinely different trade: a 0DTE spread opened at 14:00 collects far less
// premium and carries far more gamma than one opened at 09:35. It must be measured, not
// assumed to inherit the morning window's numbers.
//
// METHOD. Same instrument, same exits (50% profit target, 2x credit stop, EOD close), same
// real-option-bar data as the deploy study. The only change is that entry is attempted at
// each of several times of day, with the short strike placed SHORT_OTM_PCT below the price
// AT THAT TIME (which is what a live bot would do), not below the open.
//
// Efficiency: all strikes needed for a symbol-day are resolved as one batched
// /v1beta1/options/bars request and cached to disk, so re-running costs nothing. The naive
// per-window-per-leg loop would be ~5k serial requests.
//
// Usage: node --env-file=.env scripts/strategy-creditspread-entrywindow-sweep.js [days]
const fs = require('fs');
const path = require('path');
const client = require('../lib/alpacaClient');
const cfg = require('../lib/config');

const SYMBOLS = ['SPY', 'QQQ'];
const WIDTH = 3;                 // $ between short and long put strikes, matches deployed
const SHORT_OTM_PCT = 0.01;      // short put ~1% OTM, matches deployed
const PROFIT_TARGET_PCT = 0.5;
const STOP_MULTIPLE = 2.0;
const CLOSE_BY = '15:45';        // deployed FORCE_CLOSE_AT
// The deployed window is 09:35-10:00; 09:35 stands in for it. The rest are the candidates.
const ENTRY_TIMES = ['09:35', '10:30', '11:30', '12:30', '13:30', '14:30'];
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'option-cache-creditspread.json');

async function getHistoricalBars(symbol, days) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let all = [], tok = null;
  do {
    const res = await client.data('/v2/stocks/bars', {
      params: { symbols: symbol, timeframe: cfg.TIMEFRAME, start, limit: 10000, adjustment: 'split', feed: 'iex', page_token: tok || undefined },
    });
    all = all.concat(res.bars[symbol] || []);
    tok = res.next_page_token;
  } while (tok);
  return all;
}

function etParts(bar) {
  const d = new Date(bar.t);
  return {
    day: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    time: d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }),
  };
}
const occPut = (root, day, strike) =>
  `${root}${day.slice(2).replace(/-/g, '')}P${String(Math.round(strike * 1000)).padStart(8, '0')}`;

// One batched request for every contract needed on a symbol-day.
async function getBarsBatch(occSymbols, day) {
  const out = {};
  const CHUNK = 40;
  for (let i = 0; i < occSymbols.length; i += CHUNK) {
    const chunk = occSymbols.slice(i, i + CHUNK);
    try {
      const res = await client.data('/v1beta1/options/bars', {
        params: { symbols: chunk.join(','), timeframe: '5Min', start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z`, limit: 10000 },
      });
      if (res.bars) for (const [k, v] of Object.entries(res.bars)) out[k] = v;
    } catch { /* a chunk with no listed contracts just yields nothing */ }
  }
  return out;
}

function summarize(label, rs, extra = '') {
  if (!rs.length) { console.log(`  ${label.padEnd(10)} n=   0`); return null; }
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1));
  const se = sd / Math.sqrt(n);
  const wins = rs.filter((r) => r > 0).length;
  console.log(
    `  ${label.padEnd(10)} n=${String(n).padStart(4)}  exp=${(mean * 10000).toFixed(0).padStart(6)}bp` +
    `  t=${(mean / se).toFixed(2).padStart(6)}  win=${((100 * wins) / n).toFixed(1).padStart(5)}%` +
    `  worst=${(100 * Math.min(...rs)).toFixed(0).padStart(5)}%${extra}`
  );
  return { n, mean, se, t: mean / se, win: (100 * wins) / n };
}

async function main() {
  const days = parseInt(process.argv[2] || '180', 10);
  console.log(`0DTE put credit spread - ENTRY WINDOW sweep | ${days} days | width $${WIDTH} | short ${SHORT_OTM_PCT * 100}% OTM`);
  console.log(`Returns are expressed as a fraction of MAX RISK, same as the deploy study.\n`);

  let cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  const byWindow = {};
  for (const w of ENTRY_TIMES) byWindow[w] = [];
  let resolved = 0, skipped = 0, fetchedDays = 0;

  for (const symbol of SYMBOLS) {
    const bars = await getHistoricalBars(symbol, days);
    const parts = bars.map(etParts);
    const dayIdx = new Map();
    for (let i = 0; i < bars.length; i++) {
      const d = parts[i].day;
      if (!dayIdx.has(d)) dayIdx.set(d, []);
      dayIdx.get(d).push(i);
    }

    for (const [day, idxs] of dayIdx) {
      const byTime = new Map();
      for (const i of idxs) byTime.set(parts[i].time, bars[i]);

      // Strikes needed across every candidate window, deduped.
      const plans = [];
      const need = new Set();
      for (const w of ENTRY_TIMES) {
        const b = byTime.get(w);
        if (!b) continue;
        const shortK = Math.round(b.o * (1 - SHORT_OTM_PCT));
        const longK = shortK - WIDTH;
        if (longK <= 0) continue;
        plans.push({ w, shortK, longK });
        need.add(shortK); need.add(longK);
      }
      if (!plans.length) continue;

      const key = `${symbol}|${day}`;
      if (!(key in cache)) {
        const occs = [...need].map((k) => occPut(symbol, day, k));
        const got = await getBarsBatch(occs, day);
        // Store compactly: strike -> [[time, open, close], ...]
        const entry = {};
        for (const [occ, arr] of Object.entries(got)) {
          const strike = parseInt(occ.slice(-8), 10) / 1000;
          entry[strike] = arr.map((b) => [etParts(b).time, b.o, b.c]);
        }
        cache[key] = entry;
        fetchedDays++;
        if (fetchedDays % 25 === 0) {
          fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
          console.log(`  ...resolved ${fetchedDays} new symbol-days`);
        }
      }
      const dayCache = cache[key];

      for (const { w, shortK, longK } of plans) {
        const s = dayCache[shortK], l = dayCache[longK];
        if (!s || !l || !s.length || !l.length) { skipped++; continue; }
        const sByT = new Map(s.map((r) => [r[0], { o: r[1], c: r[2] }]));
        const lByT = new Map(l.map((r) => [r[0], { o: r[1], c: r[2] }]));
        const se = sByT.get(w), le = lByT.get(w);
        if (!se || !le) { skipped++; continue; }

        const netCredit = se.o - le.o;
        const maxRisk = WIDTH - netCredit;
        if (!(netCredit > 0) || !(maxRisk > 0)) { skipped++; continue; }

        // Walk forward from the entry bar under the deployed exit rules.
        const times = [...sByT.keys()].filter((t) => t > w && t <= CLOSE_BY).sort();
        let r = null;
        for (const t of times) {
          const sb = sByT.get(t), lb = lByT.get(t);
          if (!sb || !lb) continue;
          const pnl = netCredit - (sb.c - lb.c);
          if (pnl >= netCredit * PROFIT_TARGET_PCT) { r = pnl / maxRisk; break; }
          if (pnl <= -netCredit * (STOP_MULTIPLE - 1)) { r = pnl / maxRisk; break; }
        }
        if (r === null) {
          const last = times.length ? times[times.length - 1] : w;
          const sb = sByT.get(last), lb = lByT.get(last);
          if (!sb || !lb) { skipped++; continue; }
          r = (netCredit - (sb.c - lb.c)) / maxRisk;
        }
        byWindow[w].push({ r, symbol, day, netCredit, maxRisk });
        resolved++;
      }
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`\nResolved ${resolved} entries (${skipped} skipped, ${fetchedDays} symbol-days newly fetched)\n`);

  console.log('=== BY ENTRY TIME ===');
  const stats = {};
  for (const w of ENTRY_TIMES) {
    const rs = byWindow[w].map((x) => x.r);
    const credits = byWindow[w].map((x) => x.netCredit);
    const avgCredit = credits.length ? credits.reduce((a, b) => a + b, 0) / credits.length : 0;
    stats[w] = summarize(w, rs, `  avgCredit=$${avgCredit.toFixed(2)}`);
  }

  console.log('\n=== THE DEPLOYED WINDOW vs EVERYTHING ADDED AFTER IT ===');
  const base = byWindow['09:35'].map((x) => x.r);
  const extra = ENTRY_TIMES.slice(1).flatMap((w) => byWindow[w].map((x) => x.r));
  summarize('09:35 only', base);
  summarize('added', extra);

  console.log('\n=== OUT-OF-SAMPLE (chronological 2nd half, per window) ===');
  for (const w of ENTRY_TIMES) {
    const sorted = byWindow[w].slice().sort((a, b) => (a.day < b.day ? -1 : 1));
    const half = sorted.slice(Math.floor(sorted.length / 2)).map((x) => x.r);
    summarize(w, half);
  }

  console.log('\nA later window is only worth deploying if it is positive IN AND OUT of sample');
  console.log('with a t-stat that is not an artifact of n. Trades that lose money are not');
  console.log('progress toward "several trades a day".');
}

main().catch((e) => { console.error(e); process.exit(1); });
