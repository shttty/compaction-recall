// Offline one-question experiment. No model, embedding, compaction generation or file index.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildLocator } from './archive/js-runtime/locator.mjs';
import { CompactionIndex } from './archive/js-runtime/inverted-index.mjs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, worker: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node --expose-gc benchmark/benchmark.mjs --input QUESTION_JSON --output NEW_RESULT_JSON'); process.exit(0); }
const input = args.input;
if (!input || (!args.worker && !args.output) || (args.worker && !['scan', 'index'].includes(args.worker))) throw new Error('Explicit input, output and valid worker required');
const memory = () => { global.gc?.(); const { heapUsed, rss } = process.memoryUsage(); return { heapUsed, rss }; };
const timed = fn => { const start = performance.now(); const value = fn(); return { ms: performance.now() - start, value }; };
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
function load() {
  const q = JSON.parse(readFileSync(input, 'utf8'));
  const entries = [], evidenceIds = [];
  const sessions = q.haystack_sessions.map((turns, i) => ({ turns, date: q.haystack_dates[i] }))
    .sort((a, b) => a.date.replace(/ \(\w+\)/, '').localeCompare(b.date.replace(/ \(\w+\)/, '')));
  for (const session of sessions) {
    const turns = session.turns.map(t => ({ ...t }));
    if (!turns.length) continue;
    if (turns[0].role === 'user') turns[0].content = `[Session Date: ${session.date}]\n${turns[0].content}`;
    else turns.unshift({ role: 'user', content: `[Session Date: ${session.date}]` });
    const base = Date.parse(session.date.replace(/ \(\w+\)/, '').replaceAll('/', '-').replace(' ', 'T') + ':00Z');
    for (const turn of turns) {
      const n = entries.length + 1, id = n.toString(16).padStart(8, '0');
      const timestamp = new Date(base + n * 1000).toISOString();
      entries.push({
        type: 'message', id, parentId: entries.at(-1)?.id ?? null, timestamp,
        message: { role: turn.role, content: [{ type: 'text', text: turn.content }], timestamp: Date.parse(timestamp) }
      });
      if (turn.has_answer) evidenceIds.push(id);
    }
  }
  // Four roughly equal text-volume chunks, split at user boundaries. Simulated, not original saved snapshots.
  const total = entries.reduce((n, e) => n + e.message.content[0].text.length, 0);
  const cuts = []; let chars = 0, k = 1;
  for (let i = 0; i < entries.length; i++) {
    if (k < 4 && chars >= total * k / 4 && entries[i].message.role === 'user') { cuts.push(i); k++; }
    chars += entries[i].message.content[0].text.length;
  }
  const stages = cuts.map((cut, i) => [...entries.slice(0, cuts[i + 1] ?? entries.length),
  {
    type: 'compaction', id: `simulated${i}`, timestamp: entries[cut].timestamp,
    firstKeptEntryId: entries[cut].id, summary: '', tokensBefore: 0
  }]);
  return { question: q.question, id: q.question_id, type: q.question_type, entries, stages, evidenceIds, total, sessions: sessions.length, cuts };
}
if (args.worker) {
  const mode = args.worker, empty = memory(), data = load(), host = memory();
  const index = mode === 'index' ? new CompactionIndex() : null;
  const stages = [];
  for (let i = 0; i < data.stages.length; i++) {
    const branch = data.stages[i];
    const update = index ? timed(() => index.sync(branch)).ms : 0;
    const afterUpdate = memory();
    const getBranch = () => branch.slice(); // Include a current-branch array acquisition; not SDK parent-link traversal.
    const invoke = () => index ? index.query(data.question, getBranch()) : buildLocator(data.question, getBranch());
    const cold = timed(invoke);
    for (let j = 0; j < 3; j++) invoke();
    const times = Array.from({ length: 20 }, () => timed(invoke).ms);
    stages.push({
      compactedEntries: data.cuts[i], branchEntries: branch.length, updateMs: update,
      firstQueryMs: cold.ms, warmMedianMs: percentile(times, .5), warmP95Ms: percentile(times, .95), times,
      retainedMemory: afterUpdate, output: cold.value ?? null,
      evidenceLocatorIds: cold.value ? cold.value.trim().split("\n").slice(1).map(JSON.parse).map(row => row.id).filter(id => data.evidenceIds.includes(id)) : []
    });
  }
  console.log(JSON.stringify({
    mode, empty, host, stages, id: data.id, question: data.question, questionType: data.type,
    sessions: data.sessions, messages: data.entries.length, textUtf16Units: data.total, evidenceIds: data.evidenceIds
  }));
} else {
  const runs = [];
  for (let round = 0; round < 3; round++) for (const mode of round % 2 ? ['index', 'scan'] : ['scan', 'index']) {
    const child = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--input', input, '--worker', mode],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || `worker failed ${child.status}`);
    const result = JSON.parse(child.stdout); runs.push(result);
    console.error(`${mode} round ${round + 1}: final-stage median ${result.stages.at(-1).warmMedianMs.toFixed(2)}ms`);
  }
  const reference = runs[0].stages.map(s => s.output);
  for (const run of runs) for (let i = 0; i < reference.length; i++) if (run.stages[i].output !== reference[i]) throw new Error('Exact output parity failed');
  const report = {
    date: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0].model, cpuCount: os.cpus().length, inputSha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
    repetitions: 3, warmupPerStage: 3, measuredPerStage: 20, parity: true, runs
  };
  writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Saved ${args.output}; exact output parity passed across modes, stages and processes`);
}
