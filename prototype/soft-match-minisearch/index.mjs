import MiniSearch from 'minisearch';

// Same English values as src/locator.mjs; deliberately no Chinese stopwords.
const STOPWORDS = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your ' +
  'please tell help about find show recall remember previous earlier history').split(/\s+/));
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN = /\p{Script=Han}/u;
const PURE_HAN = /^\p{Script=Han}+$/u;

export function tokenize(text) {
  const terms = [];
  for (const match of text.matchAll(/\p{Script=Han}+|[A-Za-z0-9_]+/gu)) {
    const run = match[0];
    if (!HAN.test(run)) {
      const term = run.toLowerCase();
      if (!STOPWORDS.has(term)) terms.push(term);
      continue;
    }
    const chars = Array.from(run);
    const spans = [];
    let offset = 0;
    for (let i = 0; i + 1 < chars.length; i++) {
      spans.push({ term: chars[i] + chars[i + 1], offset, length: 2 });
      offset += chars[i].length;
    }
    for (const { segment, index, isWordLike } of segmenter.segment(run)) {
      if (!isWordLike || !PURE_HAN.test(segment)) continue;
      const length = Array.from(segment).length;
      // Every two-code-point word already has a bigram at this exact span.
      if (length > 2) spans.push({ term: segment, offset: index, length });
    }
    spans.sort((a, b) => a.offset - b.offset || a.length - b.length);
    for (const { term } of spans) terms.push(term);
  }
  return terms;
}

export function weightedLength(text) {
  let length = 0;
  for (const char of text) length += HAN.test(char) ? 2 : 1;
  return length;
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

export function createIndex(documents) {
  let engine = new MiniSearch({
    fields: ['text'],
    storeFields: [],
    tokenize,
    processTerm: term => term,
    searchOptions: { combineWith: 'OR', prefix: true, fuzzy: 0.2 },
  });
  engine.addAll(documents);
  return {
    search(query, { automatic = false, limit = 20 } = {}) {
      if (!engine) throw new Error('Index is closed');
      const text = extractText(query);
      if (automatic && weightedLength(text) > 210) {
        return { skipped: true, total: 0, results: [] };
      }
      const queryTerms = [...new Set(tokenize(text))];
      if (!queryTerms.length) return { skipped: false, total: 0, results: [], queryTerms };
      const results = engine.search(text, { tokenize: () => queryTerms });
      results.sort((a, b) => b.score - a.score ||
        (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
      return { skipped: false, total: results.length, results: results.slice(0, limit), queryTerms };
    },
    close() {
      engine = null;
    },
  };
}
