// Adapted from SQLite ext/fts5/fts5_aux.c; see FTS5_SNIPPET.md.
// Hit offsets count Unicode codepoints. Budgets do too unless weighted is explicit.
const whitespace = /\s/u;
const closingQuote = /["'”’」』）)\]]/u;
const han = /\p{Script=Han}/u;

function sentenceStarts(chars, check) {
  const starts = [0];
  let whitespaceEnd = 0;
  for (let i = 0; i < chars.length; i++) {
    check?.();
    const c = chars[i];
    if (!'.:!?。！？：\n\r'.includes(c)) continue;
    let next = i + 1;
    while (next < chars.length && closingQuote.test(chars[next])) {
      check?.();
      next++;
    }
    const spaced = next < chars.length && whitespace.test(chars[next]);
    if ('.:!?'.includes(c) && !spaced) continue;
    if (spaced && next < whitespaceEnd) next = whitespaceEnd;
    else {
      while (next < chars.length && whitespace.test(chars[next])) {
        check?.();
        next++;
      }
      whitespaceEnd = next;
    }
    if (next < chars.length && next !== starts.at(-1)) starts.push(next);
  }
  return starts;
}

// Each monotone candidate stream adds/removes every hit at most once. Separate
// streams retain the original interleaved evaluation order without rewinding.
function createWindowStats(ordered, budget, check) {
  let left = 0;
  let right = 0;
  const counts = new Map();
  return {
    score: 0, first: -1, last: 0,
    advance(start) {
      while (right < ordered.length && ordered[right].start < start + budget) {
        check?.();
        const term = ordered[right++].term;
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
      while (left < right && ordered[left].start < start) {
        check?.();
        const term = ordered[left++].term;
        const count = counts.get(term);
        if (count === 1) counts.delete(term);
        else counts.set(term, count - 1);
      }
      this.score = right - left + 999 * counts.size;
      this.first = left < right ? ordered[left].start : -1;
      // SQLite uses the final ordered instance's end, not the maximum end.
      this.last = left < right ? ordered[right - 1].end : 0;
      return this;
    },
  };
}

function codepointBoundary(positions, position, roundUp, check) {
  let lo = 0;
  let hi = positions.length - 1;
  while (lo < hi) {
    check?.();
    const mid = Math.floor((lo + hi) / 2);
    if (positions[mid] < position) lo = mid + 1;
    else hi = mid;
  }
  return roundUp || positions[lo] === position ? lo : lo - 1;
}

/** Select only a codepoint range from cached characters and {term,start,end} hits. */
export function selectFts5Range(chars, hits, budget = 120, { sentenceBonus = true, check, weighted = false } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new RangeError('budget must be a positive safe integer');
  }
  for (const hit of hits) {
    check?.();
    if (!Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end)
      || hit.start < 0 || hit.end <= hit.start || hit.end > chars.length) {
      throw new RangeError('hit offsets must be nonempty codepoint ranges within text');
    }
  }
  let positions;
  if (weighted) {
    positions = new Float64Array(chars.length + 1);
    for (let i = 0; i < chars.length; i++) {
      check?.();
      positions[i + 1] = positions[i] + (han.test(chars[i]) ? 2 : 1);
    }
  }
  const length = positions ? positions[chars.length] : chars.length;
  // Stable position order mirrors xInst; equal-position caller order is retained.
  const ordered = (positions ? hits.map(hit => {
    check?.();
    return { term: hit.term, start: positions[hit.start], end: positions[hit.end] };
  }) : [...hits]).sort((a, b) => {
    check?.();
    return a.start - b.start;
  });
  const sentences = sentenceStarts(chars, check);
  if (positions) {
    for (let i = 0; i < sentences.length; i++) {
      check?.();
      sentences[i] = positions[sentences[i]];
    }
  }
  const hitWindows = createWindowStats(ordered, budget, check);
  const precedingWindows = createWindowStats(ordered, budget, check);
  let bestStart = 0;
  let bestScore = 0;
  function consider(start, adjust, bonus, windows) {
    check?.();
    let { score, first, last } = windows.advance(start);
    // Empty sentences do not earn a bonus or move the no-hit prefix fallback.
    if (first < 0) return;
    if (sentenceBonus) score += bonus;
    if (score <= bestScore) return;
    if (adjust) {
      // C integer division truncates toward zero, including oversized matches.
      start = first - Math.trunc((budget - (last - first)) / 2);
      if (start + budget > length) start = length - budget;
      if (start < 0) start = 0;
    }
    bestScore = score;
    bestStart = start;
  }
  let sentence = 0;
  for (const hit of ordered) {
    check?.();
    consider(hit.start, true, 0, hitWindows);
    if (length <= budget) continue;
    while (sentence + 1 < sentences.length && sentences[sentence + 1] <= hit.start) {
      check?.();
      sentence++;
    }
    const start = sentences[sentence];
    if (start < hit.start) consider(start, false, start === 0 ? 120 : 100, precedingWindows);
  }
  // Deliberate extension: every sentence, including a hit exactly at its start.
  if (length > budget) {
    const allSentenceWindows = createWindowStats(ordered, budget, check);
    for (const start of sentences) consider(start, false, start === 0 ? 120 : 100, allSentenceWindows);
  }
  const end = Math.min(length, bestStart + budget);
  check?.();
  if (positions) {
    // Round inward in the selected weighted interval; never split a Han unit.
    return {
      start: codepointBoundary(positions, bestStart, true, check),
      end: codepointBoundary(positions, end, false, check),
      score: bestScore,
    };
  }
  return { start: bestStart, end, score: bestScore };
}
