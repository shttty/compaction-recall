import { Buffer } from 'node:buffer';
import { STOPWORDS, tokenize as tokenizeAutomatic } from './sqlite-lexical.mjs';
import { porterTerm } from './sqlite-porter.mjs';

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /^\p{Script=Han}+$/u;
const AUTO_BORROWED_TERM_LIMIT = 4;
const AUTO_MIN_TEXT_BYTES = 10;
const AUTO_BORROW_MAX_BYTES = 240;

function weightedLength(text) {
  let length = 0;
  for (const point of text) length += HAN.test(point) ? 2 : 1;
  return length;
}
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}
export function createAutomaticQuery({ han, stem, autoFrequency, autoGate, collect }) {
  function automaticWords(text) {
    const words = [];
    for (const part of text.normalize('NFKC').split(/(\p{Script=Han}+)/u)) {
      if (!HAN_RUN.test(part)) {
        for (const term of tokenizeAutomatic(part)) words.push({ term, surface: term });
        continue;
      }
      const add = surface => {
        const terms = tokenizeAutomatic(surface);
        if (terms.length) words.push({ term: terms.join(' '), surface });
      };
      let singles = '';
      for (const word of han.segmentHan(part)) {
        if (Array.from(word).length === 1) { singles += word; continue; }
        add(singles); singles = '';
        add(word);
      }
      add(singles);
    }
    return [...new Map(words.map(word => [word.term, word])).values()];
  }
  function automaticRows(query, timer, limit, offset = 0, eligibleCount = -1, recentUserTexts = []) {
    const text = extractText(query);
    if (weightedLength(text) > autoGate) return { skipped: true, total: 0, results: [], queryTerms: [] };
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('limit must be a non-negative safe integer');
    if (Buffer.byteLength(text.trim(), 'utf8') <= AUTO_MIN_TEXT_BYTES) return { skipped: true, total: 0, results: [], queryTerms: [] };
    const eligible = Number.isSafeInteger(eligibleCount) && eligibleCount >= 0 ? eligibleCount : -1;
    const frequencies = new Map();
    const analyze = input => automaticWords(input).filter(word => !STOPWORDS.has(word.surface)).map(word => {
      const expression = porterTerm(word.term, stem);
      if (!frequencies.has(expression)) frequencies.set(expression, autoFrequency.get(expression, eligible, eligible).total);
      return { ...word, expression, frequency: frequencies.get(expression) };
    });
    // Unseen words cannot anchor a hint, but must not block borrowing a known topic.
    const isUsable = word => word.frequency > 0;
    let words = analyze(text);
    let usable = words.filter(isUsable);
    if (!usable.length) for (const previous of recentUserTexts) {
      const bytes = Buffer.byteLength(previous.trim(), 'utf8');
      if (bytes <= AUTO_MIN_TEXT_BYTES || bytes >= AUTO_BORROW_MAX_BYTES) continue;
      usable = analyze(previous).filter(isUsable).sort((a, b) => a.frequency - b.frequency).slice(0, AUTO_BORROWED_TERM_LIMIT);
      if (usable.length) { words.push(...usable); break; } // Nearest usable topic wins.
    }
    const queryTerms = [...new Set(words.map(word => word.term))];
    if (!usable.length) return { skipped: false, total: 0, results: [], queryTerms };
    const expression = usable.map(word => word.expression).join(' OR ');
    const terms = [...new Set(queryTerms.flatMap(term => term.split(' ')))].map(term => ({ term, stem: true }));
    const found = collect(expression, terms, timer, undefined, { limit, offset, eligibleCount });
    return { skipped: false, ...found, queryTerms };
  }
  return automaticRows;
}
