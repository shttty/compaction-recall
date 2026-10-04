import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createIndex, tokenize } from '../prototype/soft-match-sqlite/index.mjs';
import { StageTiming } from '../src/timing.mjs';

// Synthetic timing only: no benchmark cases, gold answers, judges or model calls.
const { values } = parseArgs({ options: { output: { type: 'string' }, warm: { type: 'string', default: '5' } } });
if (!values.output) throw new Error('Required: --output <authorized SQLite run directory> [--warm 5]');
const warmRuns = Number(values.warm);
if (!Number.isSafeInteger(warmRuns) || warmRuns < 1) throw new Error('--warm must be a positive integer');
const allowed = '/home/rinne/.hermes/task-runs/recall-soft-match-20261003/runs/sqlite';
const output = resolve(values.output);
const within = relative(allowed, output);
if (!within || within === '..' || within.startsWith(`..${sep}`) || resolve(allowed, within) !== output) {
  throw new Error('--output must name a new directory under ' + allowed);
}
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite an earlier evidence run.

const count = 5000;
const query = 'aurora';
const expression = '"aurora"';
const stages = ['expression_rewrite', 'native_query', 'candidate_materialization', 'snippet_selection', 'snippet_render', 'deduplicate', 'mechanical_rank'];
const padding = 'cobalt granite meadow river forest copper quartz silver '.repeat(80);
function documents(duplicates) {
  return Array.from({ length: count }, (_, i) => {
    const identity = duplicates ? Math.floor(i / 5) : i;
    // Distinct identity is inside the selected window, not merely outside it.
    return {
      id: `entry-${i}`, text: `aurora marker${identity} ${padding}`,
      date: '2026-10-04', role: 'user', sourcePosition: i
    };
  });
}
function nativeIndex(docs) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(tokens, content='', columnsize=1, detail=full, tokenize="ascii tokenchars '_$'");
      BEGIN;`);
    const insert = db.prepare('INSERT INTO terms(rowid,tokens) VALUES (?,?)');
    for (let i = 0; i < docs.length; i++) insert.run(i + 1, tokenize(docs[i].text).join(' '));
    db.exec('COMMIT');
    const match = db.prepare('SELECT rowid, bm25(terms) AS score FROM terms WHERE terms MATCH ?');
    return { query: () => match.all(expression), close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}
function timed(work) {
  const start = performance.now();
  const value = work();
  return { value, durationMs: performance.now() - start };
}
function summary(events) {
  const result = {};
  for (const event of events) {
    if (event.type !== 'span') continue;
    const stage = result[event.stage] ??= { calls: 0, durationMs: 0 };
    stage.calls++;
    stage.durationMs += event.durationMs;
  }
  return result;
}
const report = {
  node: process.version, generatedAt: new Date().toISOString(), documentCount: count, warmRuns,
  query, documentCodepoints: Array.from(`aurora marker0 ${padding}`).length,
  timingNotes: [
    'cold means first query after an in-memory build, not operating-system cold cache',
    'stage durations are inclusive; do not sum nested spans as elapsed time',
    'native-only comparator uses the same tokenizer, FTS5 schema, corpus and MATCH expression',
    'native-only includes SQLite row materialization but excludes metadata, snippets, deduplication and ranking',
    'full queryRows lazily renders snippets; this measurement materializes every returned row inside the timed operation, with no top-k shortcut',
  ],
  scenarios: [],
};
for (const duplicates of [false, true]) {
  const docs = documents(duplicates);
  const timer = new StageTiming();
  const build = timed(() => createIndex(docs, { timer }));
  const index = build.value;
  let native;
  try {
    const scenario = {
      name: duplicates ? '5000-long-documents-5x-snippet-duplicates' : '5000-distinct-long-documents',
      buildMs: build.durationMs, buildStages: summary(timer.events), samples: [], nativeSamples: []
    };
    const allEvents = [...timer.events];
    timer.events.length = 0;
    for (let run = 0; run <= warmRuns; run++) {
      const sample = timed(() => {
        const found = index.queryRows(query, { mode: 'manual', timer });
        return { ...found, results: found.results.map(row => ({ ...row })) };
      });
      const breakdown = summary(timer.events);
      for (const stage of stages) if (!breakdown[stage]) throw new Error(`Missing enabled stage span: ${stage}`);
      const expected = duplicates ? count / 5 : count;
      if (sample.value.total !== expected || sample.value.results.length !== expected) {
        throw new Error(`${scenario.name}: expected ${expected} distinct results, got ${sample.value.total}/${sample.value.results.length}`);
      }
      scenario.samples.push({
        temperature: run ? 'warm' : 'cold', run, totalMs: sample.durationMs,
        total: sample.value.total, stages: breakdown
      });
      allEvents.push(...timer.events.map(event => ({ ...event, sample: run })));
      timer.events.length = 0;
    }
    const nativeBuild = timed(() => nativeIndex(docs));
    native = nativeBuild.value;
    scenario.nativeBuildMs = nativeBuild.durationMs;
    for (let run = 0; run <= warmRuns; run++) {
      const sample = timed(() => native.query());
      if (sample.value.length !== count) throw new Error('Native-only comparator did not retrieve the complete corpus');
      scenario.nativeSamples.push({ temperature: run ? 'warm' : 'cold', run, totalMs: sample.durationMs, candidates: sample.value.length });
    }
    const mean = samples => samples.reduce((sum, sample) => sum + sample.totalMs, 0) / samples.length;
    scenario.warmMeanMs = mean(scenario.samples.slice(1));
    scenario.nativeWarmMeanMs = mean(scenario.nativeSamples.slice(1));
    scenario.warmOverNativeRatio = scenario.warmMeanMs / scenario.nativeWarmMeanMs;
    await writeFile(resolve(output, `${duplicates ? 'duplicates' : 'distinct'}-timing.jsonl`),
      allEvents.map(event => JSON.stringify(event)).join('\n') + '\n');
    report.scenarios.push(scenario);
  } finally { native?.close(); index.close(); }
}
await writeFile(resolve(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  output, scenarios: report.scenarios.map(({ name, buildMs, warmMeanMs, nativeWarmMeanMs, warmOverNativeRatio }) =>
  ({ name, buildMs, warmMeanMs, nativeWarmMeanMs, warmOverNativeRatio }))
}, null, 2));
