// ORCHESTRATOR ONLY. Run only after all requested solver answers are submitted.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { data: { type: 'string' }, runs: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node benchmark/blind-evaluate.mjs --data CORPUS_JSON --runs EXTERNAL_RUNS RUN [QUESTION_ID ...]'); process.exit(0); }
const [run, ...requested] = positionals;
if (!args.data || !args.runs || !/^[a-z0-9_-]+$/.test(run ?? '')) throw new Error('Provide data, runs and RUN');
const directory = resolve(args.runs, run);
const source = JSON.parse(readFileSync(args.data));
const questions = Array.isArray(source) ? source : [source];
const selected = requested.length ? questions.filter(q => requested.includes(q.question_id)) : questions;
if (!selected.length || (requested.length && selected.length !== new Set(requested).size)) throw new Error('Unknown question ids');
const records = selected.map(q => {
  const path = resolve(directory, `${q.question_id}.jsonl`);
  if (!existsSync(path)) throw new Error(`Unfinished: ${q.question_id}`);
  const events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const final = events.find(e => e.action === 'answer');
  if (!final) throw new Error(`Unfinished: ${q.question_id}`);
  return {
    scenario: events[0].scenario, questionId: q.question_id, question: q.question, questionDate: q.question_date,
    referenceAnswer: q.answer, solverAnswer: final.answer,
    toolCounts: Object.fromEntries(['history_recall', 'history_expand', 'history_grep'].map(name => [name, events.filter(e => e.action === 'tool' && e.tool === name).length])),
    toolExecutionMs: events.filter(e => e.action === 'tool').reduce((sum, e) => sum + e.durationMs, 0),
    elapsedMs: Date.parse(final.at) - Date.parse(events[0].at),
    review: 'Pending human-readable semantic comparison; no automatic correctness claim',
  };
});
const report = { simulation: 'Native subagent with production tool execute functions; not actual Pi runtime/provider', run, records };
writeFileSync(resolve(directory, 'evaluation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
