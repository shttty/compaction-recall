// ORCHESTRATOR ONLY. Run only after all requested solver answers are submitted.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const [run, ...requested] = process.argv.slice(2);
if (!/^[a-z0-9_-]+$/.test(run ?? '')) throw new Error('Provide RUN');
const directory = resolve(import.meta.dirname, 'blind-runs', run);
const stackedPath = new URL('stacked.download.json', import.meta.url);
const questions = existsSync(stackedPath) ? JSON.parse(readFileSync(stackedPath)) :
  [JSON.parse(readFileSync(new URL('selected.download.json', import.meta.url)))];
const selected = requested.length ? questions.filter(q => requested.includes(q.question_id)) : questions;
if (!selected.length || (requested.length && selected.length !== new Set(requested).size)) throw new Error('Unknown question ids');
const records = selected.map(q => {
  const path = resolve(directory, `${q.question_id}.jsonl`);
  if (!existsSync(path)) throw new Error(`Unfinished: ${q.question_id}`);
  const events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const final = events.find(e => e.action === 'answer');
  if (!final) throw new Error(`Unfinished: ${q.question_id}`);
  return { scenario: events[0].scenario, questionId: q.question_id, question: q.question, questionDate: q.question_date,
    referenceAnswer: q.answer, solverAnswer: final.answer,
    toolCounts: Object.fromEntries(['history_recall','history_expand','history_grep'].map(name => [name, events.filter(e => e.action === 'tool' && e.tool === name).length])),
    toolExecutionMs: events.filter(e=>e.action==='tool').reduce((sum,e)=>sum+e.durationMs,0),
    elapsedMs: Date.parse(final.at)-Date.parse(events[0].at),
    review: 'Pending human-readable semantic comparison; no automatic correctness claim',
  };
});
const report = { simulation: 'Native subagent with production tool execute functions; not actual Pi runtime/provider', run, records };
writeFileSync(resolve(directory, 'evaluation.json'), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report, null, 2));
