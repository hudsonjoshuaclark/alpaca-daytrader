// Crude keyword-based news impact scoring. Two confidence tiers:
// - HIGH: unambiguous, specific phrases — strong enough to originate a trade on their own.
// - LOW: generic sentiment words — only ever used to filter/confirm, never to trigger entry.
// This is inherently imprecise (no real NLP) — negation, sarcasm, and nuanced phrasing
// ("won't face bankruptcy," "avoids recall") are the classic failure modes for keyword
// matching. A simple proximity-based negation check catches the most common cases, but
// this should be treated as a blunt instrument, not a reliable sentiment engine.

const HIGH_BULLISH = [
  'fda approval', 'fda approves', 'granted approval',
  'earnings beat', 'beats earnings', 'beat estimates', 'beats estimates', 'beats expectations',
  'raises guidance', 'raised guidance', 'guidance raised', 'raises full-year guidance',
  'share buyback', 'share repurchase program', 'announces buyback',
  'upgraded to buy', 'upgraded to overweight', 'upgraded to outperform',
  'to be acquired', 'acquisition premium',
];

const HIGH_BEARISH = [
  'fda rejects', 'fda rejection', 'complete response letter', 'fails to win approval',
  'earnings miss', 'misses earnings', 'misses estimates', 'misses expectations',
  'cuts guidance', 'lowers guidance', 'slashes guidance', 'guidance cut',
  'files for bankruptcy', 'bankruptcy filing', 'chapter 11',
  'issues recall', 'voluntary recall', 'recall of',
  'sec investigation', 'doj investigation', 'federal investigation', 'criminal investigation',
  'class action lawsuit', 'securities fraud',
  'downgraded to sell', 'downgraded to underperform', 'downgraded to underweight',
  'ceo resigns', 'ceo steps down', 'cfo resigns',
  'restates earnings', 'accounting irregularities',
  'delisted', 'delisting notice',
];

const LOW_BULLISH = [
  'surges', 'soars', 'jumps', 'rallies', 'climbs', 'outperforms',
  'strong demand', 'record revenue', 'upgraded',
];

const LOW_BEARISH = [
  'plunges', 'tumbles', 'slides', 'sinks', 'slumps',
  'weak demand', 'downgraded', 'warns', 'warning', 'probe',
];

const NEGATION_WORDS = ['not', 'no', 'never', "won't", 'wont', 'denies', 'denied', 'avoids', 'avoided', "isn't", "doesn't", 'did not', 'will not', 'rejected', 'withdrawn', 'withdraws', 'fails', 'failed'];

// Checks both directions — negation commonly follows the keyword in real headlines
// ("Approval Denied", "Guidance Withdrawn") just as often as it precedes it.
function hasNegationNear(text, matchIndex, matchLength) {
  const windowStart = Math.max(0, matchIndex - 40);
  const windowEnd = Math.min(text.length, matchIndex + matchLength + 40);
  const surrounding = text.slice(windowStart, windowEnd);
  return NEGATION_WORDS.some((neg) => surrounding.includes(neg));
}

// Returns { direction: 'bullish'|'bearish'|null, confidence: 'high'|'low'|null, matched: string|null }
function scoreHeadline(headline) {
  const text = headline.toLowerCase();

  const check = (list) => {
    for (const phrase of list) {
      const idx = text.indexOf(phrase);
      if (idx !== -1) {
        if (hasNegationNear(text, idx, phrase.length)) continue; // neutralize rather than flip — safer default
        return phrase;
      }
    }
    return null;
  };

  const highBull = check(HIGH_BULLISH);
  if (highBull) return { direction: 'bullish', confidence: 'high', matched: highBull };

  const highBear = check(HIGH_BEARISH);
  if (highBear) return { direction: 'bearish', confidence: 'high', matched: highBear };

  const lowBull = check(LOW_BULLISH);
  if (lowBull) return { direction: 'bullish', confidence: 'low', matched: lowBull };

  const lowBear = check(LOW_BEARISH);
  if (lowBear) return { direction: 'bearish', confidence: 'low', matched: lowBear };

  return { direction: null, confidence: null, matched: null };
}

module.exports = { scoreHeadline };
