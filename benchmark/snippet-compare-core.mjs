import { lex, locatorWindow } from '../src/locator.mjs';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const AUTO_STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your please tell help about find show recall remember previous earlier history').split(/\s+/));

// Position-bearing version of the two existing prototypes' identical index tokenizer.
// No new segmentation: ASCII whole identifiers, Han bigrams + >=3-point dictionary spans.
export function prototypeSpans(text) {
  const spans = [];
  const offsets = new Uint32Array(text.length + 1);
  let unit = 0, point = 0;
  for (const char of text) { offsets[unit] = point++; unit += char.length; }
  offsets[text.length] = point;
  for (const match of text.matchAll(/\p{Script=Han}+|[A-Za-z0-9_]+/gu)) {
    const run = match[0], base = offsets[match.index];
    if (!/^\p{Script=Han}+$/u.test(run)) {
      spans.push({ term: run.toLowerCase(), start: base, end: base + run.length });
      continue;
    }
    const chars = Array.from(run), pieces = [];
    for (let i = 0; i + 1 < chars.length; i++) pieces.push({ term: chars[i] + chars[i + 1], start: base + i, end: base + i + 2 });
    for (const { segment, index, isWordLike } of segmenter.segment(run)) {
      const length = Array.from(segment).length;
      if (isWordLike && /^\p{Script=Han}+$/u.test(segment) && length > 2) {
        const start = offsets[match.index + index];
        pieces.push({ term: segment, start, end: start + length });
      }
    }
    pieces.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
    spans.push(...pieces);
  }
  return spans;
}

export function queryTerms(query, prototype, automatic, tokenize) {
  if (automatic) return [...new Set(tokenize(String(query)).filter(term => !AUTO_STOPWORDS.has(term)))];
  if (prototype === 'sqlite') {
    // FTS MATCH uses ascii over the already-tokenized column, not Han re-tokenization.
    // Operators/NEAR distance are syntax, not snippet terms. Phrase words score separately.
    const chunks = String(query).match(/"(?:[^"]|"")*"|[^\s()]+/g) ?? [];
    return [...new Set(chunks.flatMap(chunk => {
      if (/^(AND|OR|NOT|NEAR)$/.test(chunk) || /^\d+\)?$/.test(chunk)) return [];
      return (chunk.replaceAll('""', '"').match(/\p{Script=Han}+|[A-Za-z0-9_]+/gu) ?? []).map(term => term.toLowerCase());
    }))];
  }
  let value = query;
  if (typeof value === 'string' && value.trimStart().startsWith('{')) value = JSON.parse(value);
  const leaves = node => typeof node === 'string' ? node.split(/\s+/).filter(Boolean) : (node?.queries ?? []).flatMap(leaves);
  // Recorded ranks lack expanded prefix/fuzzy terms. Exact indexed-token matches only.
  return [...new Set(leaves(value).map(term => term.toLowerCase()))];
}

export function literalHits(spans, terms) {
  const wanted = new Set(terms);
  return spans.filter(span => wanted.has(span.term));
}

export function prototypeWindow(text, query, prototype, budget = 120) {
  const points = Array.from(text);
  let start = 0;
  if (prototype === 'sqlite') {
    const lower = text.toLowerCase();
    let first = -1;
    for (const { term } of lex(String(query))) {
      const at = lower.indexOf(term);
      if (at >= 0 && (first < 0 || at < first)) first = at;
    }
    start = Math.max(0, (first < 0 ? 0 : Array.from(text.slice(0, first)).length) - 40);
  } else {
    for (const term of String(query).split(/\s+/)) {
      if (!term) continue;
      const at = text.indexOf(term);
      if (at >= 0) { start = Array.from(text.slice(0, at)).length; break; }
    }
  }
  const end = Math.min(points.length, start + budget);
  const body = points.slice(start, end).join('');
  return { start, end, snippet: prototype === 'sqlite' ? (start ? '…' : '') + body + (end < points.length ? '…' : '') : body };
}

export function productionWindow(text, hits, frequency, budget = 120) {
  const first = new Map();
  for (const hit of hits) if (!first.has(hit.term)) first.set(hit.term, hit.start);
  let selected = '', at = hits[0]?.start ?? 0, rarity = Infinity;
  for (const [term, offset] of first) {
    const count = frequency.get(term) ?? Infinity;
    if (count < rarity || (count === rarity && offset < at)) { selected = term; at = offset; rarity = count; }
  }
  const points = Array.from(text), center = at + Math.floor(Array.from(selected).length / 2);
  const start = Math.max(0, Math.min(center - Math.floor(budget / 2), points.length - budget));
  const utf16 = point => points.slice(0, point).join('').length;
  const candidate = {
    id: 'comparison', date: '', role: 'user', text, offset: utf16(hits[0]?.start ?? 0),
    matches: new Set(first.keys()), offsets: new Map([...first].map(([term, offset]) => [term, utf16(offset)])), recency: 0
  };
  return { start, end: Math.min(points.length, start + budget), snippet: locatorWindow(candidate, frequency, budget) };
}

export function visibleTerms(hits, window) {
  return new Set(hits.filter(hit => hit.start >= window.start && hit.end <= window.end).map(hit => hit.term)).size;
}

export function answerPositions(text, answer, special = false) {
  const tokens = value => [...value.matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({ word: match[0].toLowerCase(), index: match.index, end: match.index + match[0].length }));
  const reference = tokens(String(answer)), original = tokens(text);
  const phrases = [];
  // Enumerate all >=2-word reference phrases, longest first; no hand-picked question list.
  // One-word answers require the complete answer; stopword-only phrases are excluded.
  for (let length = Math.min(12, reference.length); length >= (reference.length === 1 ? 1 : 2); length--) {
    for (let i = 0; i + length <= reference.length; i++) {
      const words = reference.slice(i, i + length).map(token => token.word);
      if (words.every(word => AUTO_STOPWORDS.has(word))) continue;
      phrases.push(words);
    }
  }
  if (special) phrases.push(['two', 'months', 'ago']);
  const positions = [];
  for (const words of phrases) {
    for (let i = 0; i + words.length <= original.length; i++) {
      if (!words.every((word, j) => word === original[i + j].word)) continue;
      const start = Array.from(text.slice(0, original[i].index)).length;
      const end = Array.from(text.slice(0, original[i + words.length - 1].end)).length;
      if (positions.some(position => start >= position.start && end <= position.end)) continue;
      positions.push({ phrase: words.join(' '), start, end, supplemental: special && words.join(' ') === 'two months ago' });
    }
  }
  return positions.filter(position => !positions.some(other => other !== position && other.start <= position.start && other.end >= position.end && (other.start < position.start || other.end > position.end)))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}
