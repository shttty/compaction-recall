#!/usr/bin/env node
// Offline slice replay only: never builds a prototype index, opens a profile or calls a model.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { compactedEntries, searchableEntryText } from '../src/history.mjs';
import { fts5Snippet, selectFts5Window } from './fts5-snippet.mjs';
import { prototypeSpans, queryTerms, literalHits, prototypeWindow, productionWindow, visibleTerms, answerPositions } from './snippet-compare-core.mjs';
import { lex, locatorWindow } from '../src/locator.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const load = filename => JSON.parse(readFileSync(filename, 'utf8'));
const save = (filename, value) => writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const hash = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
const codeLines = text => text.split('\n').filter(line => line.trim() && !/^\s*(\/\/|\/\*|\*|\*\/)/.test(line)).length;
function functionText(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing source function ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const { values } = parseArgs({
  options: {
    run: { type: 'string', multiple: true }, output: { type: 'string' }, repeats: { type: 'string', default: '20' },
    'sqlite-tokenizer': { type: 'string' }, 'minisearch-tokenizer': { type: 'string' },
    'sqlite-adapter': { type: 'string' }, 'minisearch-adapter': { type: 'string' },
    baseline: { type: 'string' }, 'no-sentence-bonus': { type: 'boolean' },
  }
});
for (const key of ['run', 'output', 'sqlite-tokenizer', 'minisearch-tokenizer', 'sqlite-adapter', 'minisearch-adapter']) if (!values[key]) throw new Error(`--${key} is required`);
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('repeats must be a positive integer');
if (values['no-sentence-bonus'] && !values.baseline) throw new Error('--no-sentence-bonus requires the prior --baseline directory');
const baseline = values.baseline ? path.resolve(values.baseline) : undefined;
const frozenRows = baseline ? readFileSync(path.join(baseline, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : undefined;
const frozenReferences = baseline ? load(path.join(baseline, 'answer-position-samples.json')) : undefined;
const frozenReport = baseline ? load(path.join(baseline, 'report.json')) : undefined;
const referenceKey = (run, key, id) => JSON.stringify([run, key, id]);
const referenceById = new Map((frozenReferences ?? []).map(ref => [referenceKey(ref.run, ref.key, ref.id), ref]));
const tokenizers = {};
const nativeSnippets = Object.fromEntries(['sqlite', 'minisearch'].map(name => {
  // Execute only the trusted, read-only snippet function; never adapter registration.
  const source = functionText(readFileSync(values[`${name}-adapter`], 'utf8'), 'snippet')
    .replace('function snippet(text: string, query: string)', 'function snippet(text, query)');
  return [name, new Function('lex', `return (${source});`)(lex)];
}));
for (const name of ['sqlite', 'minisearch']) tokenizers[name] = (await import(pathToFileURL(path.resolve(values[`${name}-tokenizer`])).href)).tokenize;
const methods = ['prototype', 'production', 'fts5', ...(values['no-sentence-bonus'] ? ['fts5NoBonus'] : [])];
const rows = [], references = [], inputHashes = {}, skipped = [];
const corpusCache = new Map();
const timing = Object.fromEntries(methods.map(method => [method, { ns: 0n, count: 0 }]));
const contextStats = { noExactHits: 0, rawMiniQueries: 0, rawSqliteQueries: 0, prefixSqliteQueries: 0, miniJsonQueries: 0, callsWithErrors: 0 };
for (const filename of [fileURLToPath(import.meta.url), path.join(root, 'fts5-snippet.mjs'), path.join(root, 'snippet-compare-core.mjs'), path.join(root, '../src/locator.mjs'), ...['sqlite', 'minisearch'].flatMap(name => [values[`${name}-adapter`], values[`${name}-tokenizer`]])]) inputHashes[path.resolve(filename)] = hash(filename);
function corpus(metadata) {
  const key = `${metadata.key}/${metadata.language}`;
  const raw = readFileSync(metadata.snapshot, 'utf8');
  inputHashes[metadata.snapshot] = createHash('sha256').update(raw).digest('hex');
  const entries = raw.split('\n').filter(Boolean).map(JSON.parse);
  const docs = compactedEntries(entries).flatMap(entry => {
    const text = searchableEntryText(entry);
    return text === undefined ? [] : [{ id: entry.id, text }];
  });
  const signature = createHash('sha256').update(JSON.stringify(docs)).digest('hex');
  const cached = corpusCache.get(key);
  if (cached && cached.signature === signature) return cached;
  const frequency = new Map();
  for (const doc of docs) {
    const spans = prototypeSpans(doc.text);
    // Assert the position-bearing reconstruction uses precisely the actual tokenizer terms.
    for (const name of ['sqlite', 'minisearch']) {
      const expected = tokenizers[name](doc.text);
      if (JSON.stringify(expected) !== JSON.stringify(spans.map(span => span.term))) throw new Error(`Tokenizer reconstruction differs for ${key}/${doc.id}/${name}`);
    }
    for (const term of new Set(spans.map(span => span.term))) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const result = { signature, docs: new Map(docs.map(doc => [doc.id, doc.text])), frequency };
  corpusCache.set(key, result);
  return result;
}

for (const specification of values.run) {
  const separator = specification.indexOf('=');
  const label = specification.slice(0, separator), directory = path.resolve(specification.slice(separator + 1));
  if (separator < 1) throw new Error('--run requires LABEL=PATH');
  const prototype = label.startsWith('sqlite') ? 'sqlite' : label.startsWith('minisearch') ? 'minisearch' : undefined;
  if (!prototype) throw new Error('Run label must begin sqlite or minisearch');
  const prepare = load(path.join(directory, 'prepare.json'));
  const cases = load(path.join(directory, 'cases.json'));
  inputHashes[path.join(directory, 'cases.json')] = hash(path.join(directory, 'cases.json'));
  for (const descriptor of cases) {
    const metadataPath = path.join(descriptor.directory, 'retrieval.json');
    const metadata = load(metadataPath);
    inputHashes[metadataPath] = hash(metadataPath);
    const data = corpus(metadata), gold = new Set(metadata.goldIds);
    const answerPath = path.join(prepare.dataRoot, metadata.key, 'answer.json');
    const answer = load(answerPath).answer;
    inputHashes[answerPath] = hash(answerPath);
    const answerById = new Map();
    if (metadata.language === 'en') {
      for (const id of gold) {
        const text = data.docs.get(id);
        if (text === undefined) throw new Error(`Missing gold document ${id}`);
        const positions = baseline ? referenceById.get(referenceKey(label, metadata.key, id))?.positions : answerPositions(text, answer, metadata.questionId === '982b5123');
        if (!positions) throw new Error(`Missing frozen answer positions: ${label}/${metadata.key}/${id}`);
        answerById.set(id, positions);
        references.push({ run: label, key: metadata.key, id, answer, positions });
      }
    }
    const tracePath = path.join(descriptor.directory, 'timing.jsonl');
    const events = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    inputHashes[tracePath] = hash(tracePath);
    const exposures = [{ channel: 'auto', callIndex: 0, query: metadata.automaticQuery, ids: metadata.autoResults.slice(0, 5).map(row => row.id) }];
    for (const event of events) if (event.type === 'history_recall_trace') {
      if (event.error !== null && event.error !== undefined) contextStats.callsWithErrors++;
      const query = event.execute.query;
      if (prototype === 'minisearch') { contextStats.rawMiniQueries++; if (typeof query === 'string' && query.trimStart().startsWith('{')) contextStats.miniJsonQueries++; }
      else { contextStats.rawSqliteQueries++; if (String(query).includes('*')) contextStats.prefixSqliteQueries++; }
      exposures.push({ channel: 'recall', callIndex: event.callIndex, query, ids: event.result?.ids ?? [] });
    }
    for (const exposure of exposures) {
      const terms = queryTerms(exposure.query, prototype, exposure.channel === 'auto', tokenizers[prototype]);
      for (const [rank, id] of exposure.ids.entries()) {
        const text = data.docs.get(id);
        if (text === undefined) throw new Error(`Unknown returned id ${metadata.key}/${id}`);
        const hits = literalHits(prototypeSpans(text), terms);
        if (!hits.length) contextStats.noExactHits++;
        const tasks = {
          prototype: () => prototypeWindow(text, exposure.query, prototype),
          production: () => productionWindow(text, hits, data.frequency),
          fts5: () => selectFts5Window(text, hits),
          ...(values['no-sentence-bonus'] ? { fts5NoBonus: () => selectFts5Window(text, hits, 120, { sentenceBonus: false }) } : {}),
        };
        const windows = {};
        const first = new Map();
        const points = Array.from(text);
        for (const hit of hits) if (!first.has(hit.term)) first.set(hit.term, points.slice(0, hit.start).join('').length);
        const candidate = { id, date: '', role: 'user', text, offset: first.values().next().value ?? 0, matches: new Set(first.keys()), offsets: first, recency: 0 };
        const timedTasks = {
          prototype: () => nativeSnippets[prototype](text, exposure.query),
          production: () => locatorWindow(candidate, data.frequency),
          fts5: () => fts5Snippet(text, hits),
          ...(values['no-sentence-bonus'] ? { fts5NoBonus: () => fts5Snippet(text, hits, 120, { sentenceBonus: false }) } : {}),
        };
        for (const method of methods) {
          windows[method] = tasks[method]();
          if (timedTasks[method]() !== windows[method].snippet) throw new Error(`Snippet replay mismatch: ${method}/${id}`);
          timedTasks[method]();
        }
        for (const method of methods) {
          const begin = process.hrtime.bigint();
          for (let repeat = 0; repeat < repeats; repeat++) timedTasks[method]();
          timing[method].ns += process.hrtime.bigint() - begin;
          timing[method].count += repeats;
        }
        const positions = answerById.get(id) ?? [];
        rows.push({
          run: label, prototype, key: metadata.key, language: metadata.language, channel: exposure.channel,
          callIndex: exposure.callIndex, rank: rank + 1, id, query: exposure.query, textLength: Array.from(text).length,
          hits: hits.length, distinctHitTerms: new Set(hits.map(hit => hit.term)).size,
          windows, visible: Object.fromEntries(methods.map(method => [method, visibleTerms(hits, windows[method])])),
          answerPositions: positions.map(position => ({ ...position, covered: Object.fromEntries(methods.map(method => [method, position.start >= windows[method].start && position.end <= windows[method].end])) })),
          spread: Math.max(...methods.map(method => windows[method].start)) - Math.min(...methods.map(method => windows[method].start))
        });
      }
    }
  }
}
if (baseline) {
  if (rows.length !== 3605 || rows.length !== frozenRows.length) throw new Error('Frozen exposure count changed');
  for (let i = 0; i < rows.length; i++) {
    const old = frozenRows[i], row = rows[i];
    for (const field of ['run', 'prototype', 'key', 'language', 'channel', 'callIndex', 'rank', 'id', 'query', 'textLength', 'hits', 'distinctHitTerms']) {
      if (JSON.stringify(row[field]) !== JSON.stringify(old[field])) throw new Error(`Frozen input changed at row ${i}: ${field}`);
    }
    for (const method of ['prototype', 'production', 'fts5']) {
      if (JSON.stringify(row.windows[method]) !== JSON.stringify(old.windows[method])) throw new Error(`Prior ${method} window changed at row ${i}`);
    }
    const anchors = value => value.answerPositions.map(({ covered, ...position }) => position);
    if (JSON.stringify(anchors(row)) !== JSON.stringify(anchors(old))) throw new Error(`Frozen answer anchors changed at row ${i}`);
  }
  if (JSON.stringify(references) !== JSON.stringify(frozenReferences)) throw new Error('Frozen reference inventory changed');
  for (const [filename, digest] of Object.entries(inputHashes)) {
    if (filename.includes('/runs/') && frozenReport.inputHashes[filename] && digest !== frozenReport.inputHashes[filename]) throw new Error(`Frozen run bytes changed: ${filename}`);
  }
  for (const filename of ['rows.jsonl', 'answer-position-samples.json', 'report.json']) inputHashes[path.join(baseline, filename)] = hash(path.join(baseline, filename));
}
function summarize(selected) {
  const methodStats = {};
  for (const method of methods) {
    const distribution = {};
    let covered = 0, positions = 0;
    for (const row of selected) {
      distribution[row.visible[method]] = (distribution[row.visible[method]] ?? 0) + 1;
      for (const position of row.answerPositions) { positions++; if (position.covered[method]) covered++; }
    }
    methodStats[method] = {
      visibleTermsMean: selected.reduce((sum, row) => sum + row.visible[method], 0) / selected.length,
      visibleTermsDistribution: distribution, answerPositionsCovered: covered, answerPositionsTotal: positions,
      answerPositionHitRate: positions ? covered / positions : null,
      startAtZeroCount: selected.filter(row => row.windows[method].start === 0).length,
      startAtZeroRatio: selected.filter(row => row.windows[method].start === 0).length / selected.length
    };
  }
  const differs = (row, a, b) => row.windows[a].start !== row.windows[b].start || row.windows[a].end !== row.windows[b].end;
  return {
    rows: selected.length, methods: methodStats,
    differentAny: selected.filter(row => methods.slice(1).some(method => differs(row, methods[0], method))).length / selected.length,
    differentPairs: Object.fromEntries(methods.flatMap((a, i) => methods.slice(i + 1).map(b => [a, b])).map(([a, b]) => [`${a}/${b}`, selected.filter(row => differs(row, a, b)).length / selected.length]))
  };
}
const source = readFileSync(path.join(root, '../src/locator.mjs'), 'utf8');
const complexity = {
  prototype: { linesByPrototype: Object.fromEntries(['sqlite', 'minisearch'].map(name => [name, codeLines(functionText(readFileSync(values[`${name}-adapter`], 'utf8'), 'snippet'))])), needsDF: false },
  production: { lines: codeLines(functionText(source, 'snippet')) + codeLines(functionText(source, 'locatorWindow')), needsDF: true },
  fts5: { lines: codeLines(readFileSync(path.join(root, 'fts5-snippet.mjs'), 'utf8')), needsDF: false },
  ...(values['no-sentence-bonus'] ? { fts5NoBonus: { lines: codeLines(readFileSync(path.join(root, 'fts5-snippet.mjs'), 'utf8')), needsDF: false } } : {}),
};
for (const method of methods) complexity[method].meanMicroseconds = Number(timing[method].ns) / timing[method].count / 1000;
const grouped = [];
for (const run of new Set(rows.map(row => row.run))) for (const language of ['en', 'zh']) grouped.push({ run, language, ...summarize(rows.filter(row => row.run === run && row.language === language)) });
const frozenExample = frozenReport?.examples.find(row => row.key === 'dev8/982b5123' && row.id.endsWith(':00000553') && row.language === 'en');
const mandatory = frozenExample ? rows.find(row => ['run', 'key', 'language', 'id', 'channel', 'callIndex', 'rank'].every(field => row[field] === frozenExample[field]))
  : rows.filter(row => row.key === 'dev8/982b5123' && row.id.endsWith(':00000553') && row.language === 'en').sort((a, b) => b.spread - a.spread)[0];
if (!mandatory) throw new Error('Required 982b5123:00000553 example is missing');
const examples = [mandatory], seen = new Set([`${mandatory.key}/${mandatory.id}`]);
for (const row of [...rows].sort((a, b) => b.spread - a.spread || `${a.run}/${a.key}/${a.id}/${a.callIndex}`.localeCompare(`${b.run}/${b.key}/${b.id}/${b.callIndex}`))) {
  const key = `${row.key}/${row.id}`;
  if (seen.has(key)) continue;
  examples.push(row); seen.add(key);
  if (examples.length === 5) break;
}
const pairwise = {};
for (const [name, winner, loser] of [['productionOnly', 'production', 'fts5NoBonus'], ['noBonusOnly', 'fts5NoBonus', 'production']]) {
  if (!methods.includes('fts5NoBonus')) break;
  const selected = rows.filter(row => row.language === 'en' && row.answerPositions.some(position => position.covered[winner] && !position.covered[loser]));
  const ids = new Set(selected.map(row => `${row.key}/${row.id}`));
  const used = new Set();
  const examples = selected.filter(row => { const id = `${row.key}/${row.id}`; if (used.has(id)) return false; used.add(id); return true; }).slice(0, 3);
  pairwise[name] = {
    exposureCount: selected.length, uniqueEntryCount: ids.size,
    exclusiveExposureCount: selected.filter(row => !row.answerPositions.some(position => position.covered[loser])).length, examples
  };
}
const report = {
  source: 'read-only saved group2 records; no model or index rerun', command: process.argv, runtime: process.version, repeats, complexity,
  pooled: summarize(rows), grouped, contextStats, referenceGoldEntries: references.length,
  referenceGoldEntriesWithPositions: references.filter(reference => reference.positions.length).length,
  examples, inputHashes, skipped,
  pairwise, baseline: baseline ? { directory: baseline, rows: rows.length, answerPositionExposures: rows.reduce((count, row) => count + row.answerPositions.length, 0), validatedUnchanged: true } : null,
  method: {
    exposures: 'one row per auto top5 or returned recall id; repeated calls/runs retained',
    timing: '2 warmups + repeated native string-returning snippet calls; actual adapter function isolated (SQLite signature types removed only), verbatim locatorWindow with prebuilt candidate, fts5Snippet; hit extraction, candidate/window bookkeeping and DF build excluded',
    gold: 'all English gold entries; every maximal contiguous reference-answer ngram >=2 words (complete one-word answers), case/punctuation-insensitive; all positions retained; fixed extra two months ago for 982b5123; only observed returned gold rows enter rate',
    fuzzy: 'MiniSearch expanded terms are absent in saved id/score ranks; only exact indexed-token hits retained, prefix/fuzzy gains not reconstructed',
    sqlite: 'Native MATCH operators excluded; quoted phrase words treated as distinct terms, boolean/NEAR constraints not reconstructed for display scoring; prefix exact-only',
    baseline: 'actual SQLite earliest lexical substring -40 points + ellipses; actual MiniSearch first query-order case-sensitive literal +120, no ellipses',
    df: 'production locatorWindow reused verbatim; DF over the same full projected corpus and prototype index tokens, not a rerun of production retrieval'
  }
};
const output = path.resolve(values.output);
mkdirSync(output, { recursive: false, mode: 0o700 });
save(path.join(output, 'report.json'), report);
save(path.join(output, 'answer-position-samples.json'), references);
writeFileSync(path.join(output, 'rows.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
let markdown = '# Snippet-only comparison\n\nNo model calls; exposed rows and per-run/language summaries are in report.json.\n\n';
markdown += '|Method|Cutting LOC|DF|Mean µs|Mean distinct visible terms|Answer positions covered|Start at zero|\n|---|---:|---|---:|---:|---:|---:|\n';
for (const method of methods) { const c = complexity[method], s = report.pooled.methods[method]; markdown += `|${method}|${c.lines ?? JSON.stringify(c.linesByPrototype)}|${c.needsDF}|${c.meanMicroseconds.toFixed(3)}|${s.visibleTermsMean.toFixed(3)}|${s.answerPositionsCovered}/${s.answerPositionsTotal}|${s.startAtZeroCount}/${report.pooled.rows}|\n`; }
for (const example of examples) {
  markdown += `\n## ${example.run} ${example.key}/${example.language} ${example.id} ${example.channel} call ${example.callIndex}\n\nQuery: ${JSON.stringify(example.query)}; window start spread ${example.spread} points.\n`;
  for (const method of methods) markdown += `\n${method} [${example.windows[method].start},${example.windows[method].end}):\n\n> ${example.windows[method].snippet.replaceAll('\n', '\n> ')}\n`;
}
for (const [direction, stats] of Object.entries(pairwise)) {
  markdown += `\n## ${direction}: ${stats.uniqueEntryCount} unique entries; ${stats.exposureCount} paired exposures\n`;
  for (const example of stats.examples) {
    markdown += `\n${example.run} ${example.key} ${example.id} ${example.channel}/${example.callIndex}; query ${JSON.stringify(example.query)}\n`;
    for (const method of ['production', 'fts5NoBonus']) markdown += `\n${method} [${example.windows[method].start},${example.windows[method].end}):\n\n> ${example.windows[method].snippet.replaceAll('\n', '\n> ')}\n`;
  }
}
writeFileSync(path.join(output, 'comparison.md'), markdown, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, complexity, pooled: report.pooled, grouped, contextStats, referenceGoldEntriesWithPositions: report.referenceGoldEntriesWithPositions }, null, 2));
