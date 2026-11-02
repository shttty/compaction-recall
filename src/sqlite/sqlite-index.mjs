import { BIGRAM_TERM } from './sqlite-lexical.mjs';
import { createStore } from './sqlite-store.mjs';
import { createAutomaticQuery } from './automatic-query.mjs';
import { createMaterializer } from './sqlite-materialize.mjs';
import { createHanSegmentation } from './han-segmentation.mjs';
import { compileFts5 } from './concept-query-compiler.mjs';
import { parseQuery } from '../query/concept-query.mjs';
const meaningful = /[\p{L}\p{N}\p{M}]/u;
const safeQueryData = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  point => `\\u${point.charCodeAt(0).toString(16).padStart(4, '0')}`);


export function parseAutoGate(value = 280) {
  const gate = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(gate) || gate <= 0) {
    throw new RangeError('COMPACTION_RECALL_AUTO_GATE must be a positive safe integer');
  }
  return gate;
}


// Consecutive bigrams of one Han/kana run form one FTS5 phrase atom ("长江 江大 大桥"), so a multi-character word
// matches only where it is written contiguously; the index's run barrier keeps phrases from crossing punctuation.
// Duplicates stay in order ("哈哈 哈哈"). Other terms remain separate AND atoms.
function phraseAtoms(spans) {
  const atoms = [];
  let run = [];
  const flush = () => { if (run.length) atoms.push(run.map(span => span.term).join(' ')); run = []; };
  for (const span of spans) {
    if (!BIGRAM_TERM.test(span.term)) { flush(); atoms.push(span.term); continue; }
    if (run.length && span.start !== run[run.length - 1].start + 1) flush();
    run.push(span);
  }
  flush();
  return atoms;
}

// history_recall ANDs one surface's atoms. A dotted run adds an exact-run branch next to the fragment branch:
// partial runs (10.0.0) still match by fragments, and records holding the whole run (10.0.0.1) score both branches.
function surfaceBranches(spans) {
  const runs = spans.filter(span => span.term.includes('.'));
  const fragments = spans.filter(span => !span.term.includes('.'));
  if (!runs.length) return fragments.length ? [phraseAtoms(fragments)] : [];
  const exact = spans.filter(span => runs.includes(span)
    || !runs.some(run => span.start >= run.start && span.end <= run.end));
  return fragments.length ? [phraseAtoms(fragments), phraseAtoms(exact)] : [phraseAtoms(exact)];
}


export function createIndex(documents, { jieba = true, autoGate = 280, snippetBudget, measured = (_timer, _stage, work) => work(), renderPage } = {}) {
  const han = createHanSegmentation(jieba);
  autoGate = parseAutoGate(autoGate);
  const budget = Number.isSafeInteger(snippetBudget) && snippetBudget > 0 ? snippetBudget : 240;
  const { tokenize, tokenizeSpans } = han.tokenizer;
  const { corpus, stem, match, count, autoFrequency, appendDocuments, close } = createStore(documents, tokenize);


  const materialize = createMaterializer({ corpus, stem, tokenizeSpans, budget, measured });
  const automaticRows = createAutomaticQuery({ han, stem, autoFrequency, autoGate, collect });

  function collect(expression, snippetTerms, timer, check, { limit = -1, offset = 0, eligibleCount = -1 } = {}) {
    check?.();
    const eligible = Number.isSafeInteger(eligibleCount) && eligibleCount >= 0 ? eligibleCount : -1;
    const total = measured(timer, 'native_count', () => count.get(expression, eligible, eligible).total);
    check?.();
    const native = measured(timer, 'native_query', () => match.all(expression, eligible, eligible, limit, offset));
    check?.(); // SQLite is synchronous and cannot check a deadline inside MATCH.
    return { total, results: materialize(native, snippetTerms, timer, check) };
  }
  function conceptRows(query, timer, check, options) {
    check?.();
    // Items past the group/alternative/exclusion limits are dropped and reported instead of failing the call.
    const clamped = [];
    // Surfaces are NFKC-folded like indexed documents, so fullwidth and halfwidth spellings meet.
    const raw = parseQuery(query, { clamped }), analyses = new Map();
    const fold = surfaces => [...new Set(surfaces.map(surface => surface.normalize('NFKC')))];
    const parsed = { ...raw, concepts: raw.concepts.map(fold), exclude: fold(raw.exclude) };
    const analyze = surface => {
      let analysis = analyses.get(surface);
      if (!analysis) {
        const spans = tokenizeSpans(surface);
        analysis = { spans, terms: spans.map(span => span.term), branches: surfaceBranches(spans) };
        analyses.set(surface, analysis);
      }
      return analysis;
    };
    // A surface without searchable terms is dropped with a warning, like partial token loss; the query still fails
    // with the original compiler error when no positive surface remains.
    const searchable = surface => analyze(surface).terms.length > 0;
    const concepts = parsed.concepts.map(group => group.filter(searchable)).filter(group => group.length);
    const normalized = concepts.length ? { ...parsed, concepts, exclude: parsed.exclude.filter(searchable) } : parsed;
    const dropped = concepts.length ? [...new Set([...parsed.concepts.flat(), ...parsed.exclude].filter(surface => !searchable(surface)))] : [];
    const plan = measured(timer, 'concept_query_compile', () => compileFts5(normalized, surface => analyze(surface).branches));
    // Compile first so zero-token surfaces retain the author's original error.
    const warnings = clamped.map(({ path, max, ignored }) => `Warning: ${path} has more than ${max} items; ignored ${safeQueryData(ignored)}.`);
    if (dropped.length) warnings.push(`Warning: ${safeQueryData(dropped)} produced no searchable terms and ${dropped.length === 1 ? 'was' : 'were'} ignored. Suggestion: use other words or history_grep.`);
    for (const [surface, { spans, terms }] of analyses) {
      check?.();
      if (!terms.length) continue;
      const chars = Array.from(surface), covered = new Uint8Array(chars.length);
      for (const span of spans) covered.fill(1, span.start, span.end);
      if (chars.some((point, at) => meaningful.test(point) && !covered[at])) {
        warnings.push(`Warning: ${safeQueryData(surface)} → ${safeQueryData([...new Set(terms)])}. Suggestion: revise query terms or use history_grep.`);
      }
    }
    // Only positive terms select snippets; exclusions remain in MATCH alone.
    const terms = new Set(normalized.concepts.flatMap(group => group.flatMap(surface => analyses.get(surface).terms)));
    const snippets = [...terms].map(term => ({ term }));
    check?.();
    return { ...collect(plan.match, snippets, timer, check, options), warnings };
  }
  return {
    get size() { return corpus.length; },
    append(documents) { appendDocuments(documents); },
    queryRows(query, { mode = 'manual', timer, check, limit, offset = 0, eligibleCount = -1, recentUserTexts = [] } = {}) {
      return mode === 'auto' ? automaticRows(query, timer, limit, offset, eligibleCount, recentUserTexts) : conceptRows(query, timer, check, { limit, offset, eligibleCount });
    },
    queryPage(query, options = {}, { timer, check } = {}) {
      const limit = options.limit ?? 50, offset = options.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('limit must be an integer from 1 to 50');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a nonnegative safe integer');
      const found = conceptRows(query, timer, check, { limit, offset, eligibleCount: options.eligibleCount });
      const page = renderPage(found.results, options, { total: found.total, baseOffset: offset, warnings: found.warnings });
      check?.();
      const ids = found.results.slice(0, page.details.returned).map(row => row.id);
      return { total: found.total, page, ids };
    },
    close() { close(); },
  };
}
