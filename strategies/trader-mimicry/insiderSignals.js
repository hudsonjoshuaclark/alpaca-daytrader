// Real SEC EDGAR Form 4 insider-buy signals. No API key needed - SEC requires only a
// descriptive User-Agent identifying the requester (fair-access policy, not a paywall).
// Verified live 2026-07-28 against the real feed and a real filing's XML.
//
// Two-step fetch, because the "getcurrent" feed only says WHO filed, not WHAT they did:
//   1. GET the current-filings atom feed, client-side-filtered to exact form type "4"
//      (the server's type= param does loose prefix/substring matching, not exact - e.g.
//      type=4 also returns 424B2, 485BXT, etc. - confirmed live, so filtering happens here).
//   2. For each, GET the filing's index page to find its real ownership XML document
//      (filenames vary by filer software - "primarydocument.xml" is common but not
//      universal, so this scans the index page's <a> tags for a .xml link that isn't the
//      xslF345X06 viewer-transform path), then parse it for genuine open-market buys.
//
// The signal that matters: transactionCode='P' (open market purchase) with
// transactionAcquiredDisposedCode='A' (acquired) in the NON-derivative table - real cash
// spent buying the stock on the open market. Routine RSU/option grants (code 'A', $0
// price) and 10b5-1 scheduled sales are noise and explicitly excluded.
const SEC_UA = 'alpaca-daytrader-research contact:hudsonjoshuaclark@gmail.com';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function fetchCurrentForm4Filings(count = 100) {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=${count}&output=atom`;
  const xml = await fetchText(url);
  const entries = xml.split('<entry>').slice(1);
  const filings = [];
  for (const e of entries) {
    if (!/term="4"/.test(e)) continue; // client-side exact filter - see file comment
    const linkMatch = e.match(/href="([^"]+)"/);
    const titleMatch = e.match(/<title>([^<]+)<\/title>/);
    if (!linkMatch || !titleMatch) continue;
    filings.push({ title: titleMatch[1], indexUrl: linkMatch[1] });
  }
  // de-dupe: the feed lists one entry per party to a filing (reporting owner AND issuer
  // both get their own <entry> for the same accession), so multiple entries can share
  // the same indexUrl.
  const seen = new Set();
  return filings.filter((f) => (seen.has(f.indexUrl) ? false : (seen.add(f.indexUrl), true)));
}

async function findOwnershipXmlUrl(indexUrl) {
  const html = await fetchText(indexUrl);
  const hrefs = [...html.matchAll(/href="([^"]+\.xml)"/gi)].map((m) => m[1]);
  const direct = hrefs.find((h) => !h.includes('/xsl'));
  if (!direct) return null;
  return direct.startsWith('http') ? direct : `https://www.sec.gov${direct}`;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>\\s*([^<]*)\\s*<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function extractValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}>\\s*<value>\\s*([^<]*)\\s*<\\/value>`));
  return m ? m[1].trim() : null;
}

function parseForm4Xml(xml) {
  const ticker = extractTag(xml, 'issuerTradingSymbol');
  const issuerName = extractTag(xml, 'issuerName');
  if (!ticker) return null;

  const isOfficer = extractTag(xml, 'isOfficer') === 'true';
  const isDirector = extractTag(xml, 'isDirector') === 'true';
  const isTenPercentOwner = extractTag(xml, 'isTenPercentOwner') === 'true';
  const officerTitle = extractTag(xml, 'officerTitle') || null;
  const ownerName = extractTag(xml, 'rptOwnerName');

  const nonDerivMatch = xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/);
  if (!nonDerivMatch) return { ticker, issuerName, buys: [] };

  const transactions = nonDerivMatch[1].split('<nonDerivativeTransaction>').slice(1);
  const buys = [];
  for (const t of transactions) {
    const code = extractTag(t, 'transactionCode');
    const acqDisp = extractValue(t, 'transactionAcquiredDisposedCode');
    if (code !== 'P' || acqDisp !== 'A') continue; // only genuine open-market purchases
    const shares = parseFloat(extractValue(t, 'transactionShares')) || 0;
    const price = parseFloat(extractValue(t, 'transactionPricePerShare')) || 0;
    const value = shares * price;
    if (value <= 0) continue;
    buys.push({ shares, price, value });
  }
  if (buys.length === 0) return { ticker, issuerName, buys: [] };

  return {
    ticker, issuerName, ownerName,
    isOfficer, isDirector, isTenPercentOwner, officerTitle,
    buys,
    totalValue: buys.reduce((a, b) => a + b.value, 0),
  };
}

// Orchestrates the full pipeline, returns only genuine open-market buys >= minValueUsd,
// sorted by total value descending (biggest conviction first).
async function gatherInsiderBuySignals({ minValueUsd = 100000, maxFilings = 100 } = {}) {
  const filings = await fetchCurrentForm4Filings(maxFilings);
  const results = [];
  for (const filing of filings) {
    try {
      const xmlUrl = await findOwnershipXmlUrl(filing.indexUrl);
      if (!xmlUrl) continue;
      const xml = await fetchText(xmlUrl);
      const parsed = parseForm4Xml(xml);
      if (!parsed || parsed.buys.length === 0) continue;
      if (parsed.totalValue < minValueUsd) continue;
      results.push({ ...parsed, indexUrl: filing.indexUrl });
    } catch (e) {
      // one bad filing shouldn't kill the whole scan
      continue;
    }
  }
  return results.sort((a, b) => b.totalValue - a.totalValue);
}

module.exports = { fetchCurrentForm4Filings, findOwnershipXmlUrl, parseForm4Xml, gatherInsiderBuySignals };
