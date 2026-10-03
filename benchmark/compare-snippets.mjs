#!/usr/bin/env node
// Offline slice replay only: never builds a prototype index, opens a profile or calls a model.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { compactedEntries, searchableEntryText } from '../src/history.mjs';
import { selectFts5Window } from './fts5-snippet.mjs';
import { prototypeSpans, queryTerms, literalHits, prototypeWindow, productionWindow, visibleTerms, answerPositions } from './snippet-compare-core.mjs';

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
  }
});
for (const key of ['run', 'output', 'sqlite-tokenizer', 'minisearch-tokenizer', 'sqlite-adapter', 'minisearch-adapter']) if (!values[key]) throw new Error(`--${key} is required`);
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('repeats must be a positive integer');
const tokenizers = {};
for (const name of ['sqlite', 'minisearch']) tokenizers[name] = (await import(pathToFileURL(path.resolve(values[`${name}-tokenizer`])).href)).tokenize;
const methods = ['prototype', 'production', 'fts5'];
const rows = [], references = [], inputHashes = {}, skipped = [];
const corpusCache = new Map();
const timing = Object.fromEntries(methods.map(method => [method, { ns: 0n, count: 0 }]));
const contextStats = { noExactHits: 0, rawMiniQueries: 0, rawSqliteQueries: 0, prefixSqliteQueries: 0, miniJsonQueries: 0, callsWithErrors: 0 };
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
        const positions = answerPositions(text, answer, metadata.questionId === '982b5123');
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
        };
        const windows = {};
        // Warm-up outside timed interval. All methods see identical original text and query.
        for (const method of methods) { windows[method] = tasks[method](); tasks[method](); }
        for (const method of methods) {
          const begin = process.hrtime.bigint();
          for (let repeat = 0; repeat < repeats; repeat++) tasks[method]();
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
      answerPositionHitRate: positions ? covered / positions : null
    };
  }
  const differs = (row, a, b) => row.windows[a].start !== row.windows[b].start || row.windows[a].end !== row.windows[b].end;
  return {
    rows: selected.length, methods: methodStats,
    differentAny: selected.filter(row => differs(row, 'prototype', 'production') || differs(row, 'prototype', 'fts5')).length / selected.length,
    differentPairs: Object.fromEntries([['prototype', 'production'], ['prototype', 'fts5'], ['production', 'fts5']].map(([a, b]) => [`${a}/${b}`, selected.filter(row => differs(row, a, b)).length / selected.length]))
  };
}
const source = readFileSync(path.join(root, '../src/locator.mjs'), 'utf8');
const complexity = {
  prototype: { linesByPrototype: Object.fromEntries(['sqlite', 'minisearch'].map(name => [name, codeLines(functionText(readFileSync(values[`${name}-adapter`], 'utf8'), 'snippet'))])), needsDF: false },
  production: { lines: codeLines(functionText(source, 'snippet')) + codeLines(functionText(source, 'locatorWindow')), needsDF: true },
  fts5: { lines: codeLines(readFileSync(path.join(root, 'fts5-snippet.mjs'), 'utf8')), needsDF: false },
};
for (const method of methods) complexity[method].meanMicroseconds = Number(timing[method].ns) / timing[method].count / 1000;
const grouped = [];
for (const run of new Set(rows.map(row => row.run))) for (const language of ['en', 'zh']) grouped.push({ run, language, ...summarize(rows.filter(row => row.run === run && row.language === language)) });
const mandatory = rows.filter(row => row.key === 'dev8/982b5123' && row.id.endsWith(':00000553') && row.language === 'en').sort((a, b) => b.spread - a.spread)[0];
if (!mandatory) throw new Error('Required 982b5123:00000553 example is missing');
const examples = [mandatory], seen = new Set([`${mandatory.key}/${mandatory.id}`]);
for (const row of [...rows].sort((a, b) => b.spread - a.spread || `${a.run}/${a.key}/${a.id}/${a.callIndex}`.localeCompare(`${b.run}/${b.key}/${b.id}/${b.callIndex}`))) {
  const key = `${row.key}/${row.id}`;
  if (seen.has(key)) continue;
  examples.push(row); seen.add(key);
  if (examples.length === 5) break;
}
const report = {
  source: 'read-only saved group2 records; no model or index rerun', repeats, complexity,
  pooled: summarize(rows), grouped, contextStats, referenceGoldEntries: references.length,
  referenceGoldEntriesWithPositions: references.filter(reference => reference.positions.length).length,
  examples, inputHashes, skipped,
  method: {
    exposures: 'one row per auto top5 or returned recall id; repeated calls/runs retained',
    timing: '2 warmups + repeated isolated snippet calls; common hit extraction and corpus DF build excluded',
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
markdown += '|Method|Cutting LOC|DF|Mean µs|Mean distinct visible terms|Answer positions covered|\n|---|---:|---|---:|---:|---:|\n';
for (const method of methods) { const c = complexity[method], s = report.pooled.methods[method]; markdown += `|${method}|${c.lines ?? JSON.stringify(c.linesByPrototype)}|${c.needsDF}|${c.meanMicroseconds.toFixed(3)}|${s.visibleTermsMean.toFixed(3)}|${s.answerPositionsCovered}/${s.answerPositionsTotal}|\n`; }
for (const example of examples) {
  markdown += `\n## ${example.run} ${example.key}/${example.language} ${example.id} ${example.channel} call ${example.callIndex}\n\nQuery: ${JSON.stringify(example.query)}; window start spread ${example.spread} points.\n`;
  for (const method of methods) markdown += `\n${method} [${example.windows[method].start},${example.windows[method].end}):\n\n> ${example.windows[method].snippet.replaceAll('\n', '\n> ')}\n`;
}
writeFileSync(path.join(output, 'comparison.md'), markdown, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, complexity, pooled: report.pooled, grouped, contextStats, referenceGoldEntriesWithPositions: report.referenceGoldEntriesWithPositions }, null, 2));
