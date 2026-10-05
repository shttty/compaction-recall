import { compileFts5, parseQuery } from './concept-query-compiler.mjs';
import { measured } from '../../src/timing.mjs';

const meaningful = /[\p{L}\p{N}\p{M}]/u;
const CHUNK_UNITS = 8192;
const escapeLiteral = surface => surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fullyCovered(surface, spans) {
  const chars = Array.from(surface), covered = new Uint8Array(chars.length);
  for (const span of spans) for (let at = span.start; at < span.end; at++) covered[at] = 1;
  return spans.length > 0 && chars.every((char, at) => !meaningful.test(char) || covered[at]);
}

// Routing is a property of the surface/tokenizer, never of its query results.
export function prepareRecallQuery(input, tokenizeSpans, analyze, check) {
  const query = parseQuery(input), predicates = new Map();
  for (const surface of [...query.concepts.flat(), ...query.exclude]) {
    check?.();
    if (predicates.has(surface)) continue;
    const literal = !fullyCovered(surface, tokenizeSpans(surface));
    const predicate = { surface, literal };
    if (literal) predicate.regex = new RegExp(escapeLiteral(surface), 'iu');
    else predicate.analysis = analyze(surface);
    predicates.set(surface, predicate);
  }
  const fallback = [...predicates.values()].filter(predicate => predicate.literal);
  const analyzeIndexed = surface => predicates.get(surface).analysis;
  if (!fallback.length) return { query, predicates, match: compileFts5(query, analyzeIndexed).match };

  // Validate the actual FTS subset together, retaining the author's aggregate
  // analysis/resource limits. Literal predicates are not fake indexed atoms.
  const concepts = query.concepts.map(group => group.filter(surface => !predicates.get(surface).literal)).filter(group => group.length);
  const exclude = query.exclude.filter(surface => !predicates.get(surface).literal);
  if (concepts.length) compileFts5({ concepts, match: query.match, exclude }, analyzeIndexed);
  else if (exclude.length) compileFts5({ concepts: [[exclude[0]]], exclude: exclude.slice(1) }, analyzeIndexed);
  for (const predicate of predicates.values()) {
    check?.();
    if (!predicate.literal) predicate.expression = compileFts5({ concepts: [[predicate.surface]] }, analyzeIndexed).match;
  }
  return { query, predicates, fallback };
}

function literalHit(text, predicate, check) {
  for (let start = 0; start < text.length; start += CHUNK_UNITS) {
    check?.();
    // Overlap preserves occurrences crossing a chunk or surrogate boundary.
    const match = predicate.regex.exec(text.slice(start, start + CHUNK_UNITS + predicate.surface.length));
    check?.();
    if (match) return { start: start + match.index, end: start + match.index + match[0].length };
  }
}

function compare(a, b, corpus, check) {
  check?.();
  const left = corpus[a.rowid - 1], right = corpus[b.rowid - 1];
  return b.score - a.score || b.groups - a.groups ||
    (left.timestamp < right.timestamp ? 1 : left.timestamp > right.timestamp ? -1 : 0) ||
    right.recency - left.recency || b.rowid - a.rowid;
}

// Query-lifetime match/offset maps only; text remains in the one existing corpus.
export function matchRecallFallback(plan, corpus, ftsMatches, contentHashes, timer, check, { limit = -1, offset = 0 } = {}) {
  const { query, predicates, fallback } = plan;
  for (const predicate of predicates.values()) {
    check?.();
    predicate.hits = new Map();
    if (predicate.literal) measured(timer, 'fallback_scan', () => {
      for (let at = 0; at < corpus.length; at++) {
        check?.();
        const hit = literalHit(corpus[at].text, predicate, check);
        if (hit) predicate.hits.set(at + 1, hit);
      }
    });
    else measured(timer, 'fallback_fts_surface', () => {
      for (const rowid of ftsMatches(predicate.expression)) {
        check?.();
        predicate.hits.set(rowid, undefined);
      }
    });
    // DF is the complete surface predicate's row count, before filters/dedupe.
    predicate.weight = 1 + Math.log((corpus.length + 1) / (predicate.hits.size + 1));
  }
  const groups = query.concepts.map(group => group.map(surface => predicates.get(surface)));
  const uniqueGroups = [...new Map(groups.map(group => [JSON.stringify([...new Set(group.map(predicate => JSON.stringify(predicate.literal
    ? ['literal', predicate.surface] : ['fts', predicate.expression])))].sort()), group])).values()];
  const candidates = measured(timer, 'fallback_rank', () => {
    const found = [];
    for (let at = 0; at < corpus.length; at++) {
      check?.();
      const rowid = at + 1;
      let score = 0, count = 0;
      const anchors = [];
      for (const group of uniqueGroups) {
        let maximum = 0;
        for (const predicate of group) if (predicate.hits.has(rowid)) {
          maximum = Math.max(maximum, predicate.weight);
          if (predicate.literal) anchors.push({ ...predicate.hits.get(rowid), term: predicate.surface });
        }
        if (maximum) { score += maximum; count++; }
      }
      if (!count || (query.match === 'all' && count !== uniqueGroups.length)) continue;
      if (query.exclude.some(surface => predicates.get(surface).hits.has(rowid))) continue;
      found.push({ rowid, score, groups: count, anchors });
    }
    found.sort((a, b) => compare(a, b, corpus, check));
    return found;
  });
  const distinct = measured(timer, 'fallback_deduplicate', () => {
    const hashes = contentHashes(), seen = new Set(), found = [];
    for (const row of candidates) {
      check?.();
      const hash = hashes.get(row.rowid);
      if (seen.has(hash)) continue;
      seen.add(hash); found.push(row);
    }
    return found;
  });
  check?.();
  return {
    total: distinct.length,
    rows: distinct.slice(offset, limit < 0 ? undefined : offset + limit),
    fallback: { surfaces: fallback.map(predicate => predicate.surface), scannedDocuments: corpus.length, ranking: 'rarity' },
  };
}
