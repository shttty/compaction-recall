// Adapted from SQLite ext/fts5/fts5_aux.c; see FTS5_SNIPPET.md.
// Offsets and budgets count Unicode codepoints, not UTF-16 units or tokens.
const whitespace = /\s/u;
const closingQuote = /["'”’」』）)\]]/u;

function sentenceStarts(chars) {
  const starts = [0];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!'.:!?。！？：\n\r'.includes(c)) continue;
    let next = i + 1;
    while (next < chars.length && closingQuote.test(chars[next])) next++;
    const spaced = next < chars.length && whitespace.test(chars[next]);
    if ('.:!?'.includes(c) && !spaced) continue;
    while (next < chars.length && whitespace.test(chars[next])) next++;
    if (next < chars.length && next !== starts.at(-1)) starts.push(next);
  }
  return starts;
}

/** Select a codepoint window from caller-provided {term,start,end} hits. */
export function selectFts5Window(text, hits, budget = 120, { sentenceBonus = true } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new RangeError('budget must be a positive safe integer');
  }
  const chars = Array.from(text);
  for (const hit of hits) {
    if (!Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end)
      || hit.start < 0 || hit.end <= hit.start || hit.end > chars.length) {
      throw new RangeError('hit offsets must be nonempty codepoint ranges within text');
    }
  }
  // Stable position order mirrors xInst; equal-position caller order is retained.
  const ordered = [...hits].sort((a, b) => a.start - b.start);
  const sentences = sentenceStarts(chars);
  let bestStart = 0;
  let bestScore = 0;
  function consider(start, adjust, bonus = 0) {
    const seen = new Set();
    let score = 0;
    let first = -1;
    let last = 0;
    for (const hit of ordered) {
      if (hit.start < start) continue;
      if (hit.start >= start + budget) break;
      score += seen.has(hit.term) ? 1 : 1000;
      seen.add(hit.term);
      if (first < 0) first = hit.start;
      last = hit.end;
    }
    // Empty sentences do not earn a bonus or move the no-hit prefix fallback.
    if (first < 0) return;
    if (sentenceBonus) score += bonus;
    if (score <= bestScore) return;
    if (adjust) {
      // C integer division truncates toward zero, including oversized matches.
      start = first - Math.trunc((budget - (last - first)) / 2);
      if (start + budget > chars.length) start = chars.length - budget;
      if (start < 0) start = 0;
    }
    bestScore = score;
    bestStart = start;
  }
  let sentence = 0;
  for (const hit of ordered) {
    consider(hit.start, true);
    if (chars.length <= budget) continue;
    while (sentence + 1 < sentences.length && sentences[sentence + 1] <= hit.start) sentence++;
    const start = sentences[sentence];
    if (start < hit.start) consider(start, false, start === 0 ? 120 : 100);
  }
  // Deliberate extension: every sentence, including a hit exactly at its start.
  if (chars.length > budget) {
    for (const start of sentences) consider(start, false, start === 0 ? 120 : 100);
  }
  const end = Math.min(chars.length, bestStart + budget);
  const snippet = `${bestStart > 0 ? '…' : ''}${chars.slice(bestStart, end).join('')}${end < chars.length ? '…' : ''}`;
  return { start: bestStart, end, score: bestScore, snippet };
}

export function fts5Snippet(text, hits, budget = 120, options = {}) {
  return selectFts5Window(text, hits, budget, options).snippet;
}
