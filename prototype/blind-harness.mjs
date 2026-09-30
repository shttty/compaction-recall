// Native solvers may call only this CLI; evaluator and corpus files are out of bounds.
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createBlindHarness } from './blind-harness-core.mjs';
const [scenario, action, id, run, name, raw] = process.argv.slice(2);
if (!['single','stacked'].includes(scenario) || !['start','tool','answer'].includes(action) || !/^[A-Za-z0-9_-]+$/.test(id ?? '') || !/^[a-z0-9_-]+$/.test(run ?? '')) {
  throw new Error('Usage: node prototype/blind-harness.mjs single|stacked start|tool|answer QUESTION_ID RUN [TOOL_NAME JSON | ANSWER_JSON]');
}
const directory = resolve(import.meta.dirname, 'blind-runs', run);
mkdirSync(directory, { recursive: true });
const log = resolve(directory, `${id}.jsonl`);
const previous = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
if (previous.some(e => e.scenario !== scenario)) throw new Error('Run scenario cannot change');
if (action !== 'start' && !previous.some(e => e.action === 'start')) throw new Error('Start this question first');
if (previous.some(e => e.action === 'answer')) throw new Error('Answer already submitted; run is closed');
const output = value => { console.log(JSON.stringify(value, null, 2)); };
if (action === 'answer') {
  const answer = JSON.parse(name ?? '{}');
  if (typeof answer.answer !== 'string' || !answer.answer.trim()) throw new Error('Provide a nonempty answer string');
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), scenario, action, answer }) + '\n');
  output({ recorded: true, questionId: id, message: 'Answer recorded without feedback or grading' });
} else {
  // Raw corpus and gold annotations stay inside the adapter; only whitelisted message fields survive.
  const source = JSON.parse(readFileSync(new URL(scenario === 'single' ? 'selected.download.json' : 'stacked.download.json', import.meta.url), 'utf8'));
  const harness = createBlindHarness(scenario === 'single' ? [source] : source);
  const start = performance.now();
  const parameters = action === 'tool' ? JSON.parse(raw ?? '{}') : undefined;
  const result = action === 'start' ? await harness.start(id) : await harness.execute(name, parameters);
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), scenario, action, tool: name, parameters,
    durationMs: performance.now() - start, result }) + '\n');
  output(result);
}
