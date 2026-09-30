// Stacked real-haystack stress experiment: no models or production index changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildLocator } from '../locator.ts';
import { CompactionIndex } from './inverted-index.mjs';
const input = process.argv[2];
if (!input) throw new Error('Usage: node --expose-gc prototype/stacked-benchmark.mjs prototype/stacked.download.json [--pilot | --worker scan|index ROUND]');
const hash = text => createHash('sha256').update(text).digest('hex');
const memory = () => { global.gc?.(); const { heapUsed, rss } = process.memoryUsage(); return { heapUsed, rss }; };
const timed = fn => { const start = performance.now(); const value = fn(); return { ms: performance.now() - start, value }; };
function load() {
  const questions = JSON.parse(readFileSync(input, 'utf8'));
  const entries = [], uniqueTurns = new Map(), uniqueSessions = new Set(), evidence = {}, entryKeys = new Map();
  let rawChars = 0, sessionsCount = 0;
  for (const q of questions) {
    evidence[q.question_id] = new Set();
    const sessions = q.haystack_sessions.map((turns, i) => ({ turns, date: q.haystack_dates[i] }))
      .sort((a, b) => a.date.replace(/ \(\w+\)/, '').localeCompare(b.date.replace(/ \(\w+\)/, '')));
    let seq = 0;
    for (const session of sessions) {
      if (!session.turns.length) continue;
      sessionsCount++;
      uniqueSessions.add(hash(JSON.stringify(session.turns.map(t => [t.role, t.content]))));
      const turns = session.turns.map(t => ({ ...t, rawKey: hash(JSON.stringify([t.role, t.content])) }));
      for (const turn of turns) {
        rawChars += turn.content.length;
        uniqueTurns.set(turn.rawKey, turn.content.length);
        if (turn.has_answer) evidence[q.question_id].add(turn.rawKey);
      }
      if (turns[0].role === 'user') turns[0].content = `[Session Date: ${session.date}]\n${turns[0].content}`;
      else turns.unshift({ role: 'user', content: `[Session Date: ${session.date}]`, rawKey: null });
      const base = Date.parse(session.date.replace(/ \(\w+\)/, '').replaceAll('/', '-').replace(' ', 'T') + ':00Z');
      for (const turn of turns) {
        const id = `${q.question_id}:${(++seq).toString(16).padStart(8, '0')}`;
        const timestamp = new Date(base + seq * 1000).toISOString();
        entries.push({ type: 'message', id, parentId: entries.at(-1)?.id ?? null, timestamp,
          message: { role: turn.role, content: [{ type: 'text', text: turn.content }], timestamp: Date.parse(timestamp) } });
        entryKeys.set(id, turn.rawKey);
      }
    }
  }
  const total = entries.reduce((n, e) => n + e.message.content[0].text.length, 0);
  const cuts = []; let chars = 0, k = 0;
  const fractions = [.25, .5];
  for (let i = 0; i < entries.length; i++) {
    if (k < fractions.length && chars >= total * fractions[k] && entries[i].message.role === 'user') { cuts.push(i); k++; }
    chars += entries[i].message.content[0].text.length;
  }
  cuts.push(entries.length);
  const tail = { type: 'message', id: 'retained:tail', timestamp: '2026-09-30T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'retained tail' }], timestamp: 0 } };
  const stages = cuts.map((cut, i) => [...entries.slice(0, cuts[i + 1] ?? entries.length), tail,
    { type: 'compaction', id: `stacked-simulated-${i}`, timestamp: tail.timestamp,
      firstKeptEntryId: entries[cut]?.id ?? tail.id, summary: '', tokensBefore: 0 }]);
  return { entries, stages, entryKeys, evidence, queries: questions.map(q => ({ id: q.question_id, text: q.question })),
    stats: { sessions: sessionsCount, messages: entries.length, textUtf16Units: total, rawTextUtf16Units: rawChars,
      uniqueRawTurns: uniqueTurns.size, uniqueRawTurnTextUtf16Units: [...uniqueTurns.values()].reduce((a, b) => a + b, 0),
      uniqueSessionsIgnoringDates: uniqueSessions.size, roughTokensAt4_84Chars: total / 4.84, cuts } };
}
const workerAt = process.argv.indexOf('--worker');
if (process.argv.includes('--pilot')) {
  const baseline = memory(), data = load(), host = memory();
  const branch = data.stages.at(-1), index = new CompactionIndex();
  const scan = timed(() => buildLocator(data.queries[0].text, branch.slice()));
  const build = timed(() => index.sync(branch));
  const retained = memory();
  const lookup = timed(() => index.query(data.queries[0].text, branch.slice()));
  if (scan.value !== lookup.value) throw new Error('Pilot parity failed');
  const result = { stats: data.stats, baseline, host, retained, scanMs: scan.ms, buildMs: build.ms, lookupMs: lookup.ms };
  writeFileSync(new URL('stacked-pilot.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} else if (workerAt >= 0) {
  const mode = process.argv[workerAt + 1], round = Number(process.argv[workerAt + 2] ?? 0);
  const empty = memory(), data = load(), host = memory();
  const index = mode === 'index' ? new CompactionIndex() : null;
  const stages = [];
  for (let i = 0; i < data.stages.length; i++) {
    const branch = data.stages[i];
    const updateMs = index ? timed(() => index.sync(branch)).ms : 0;
    const retainedMemory = memory();
    const invoke = query => index ? index.query(query, branch.slice()) : buildLocator(query, branch.slice());
    // One measured cold request + one warmup per stage; no per-question caches.
    const cold = timed(() => invoke(data.queries[round % data.queries.length].text));
    invoke(data.queries[(round + 1) % data.queries.length].text);
    const results = [];
    for (let j = 0; j < data.queries.length; j++) {
      const query = data.queries[(j + round * 3) % data.queries.length];
      const { ms, value } = timed(() => invoke(query.text));
      const rows = value ? value.trim().split('\n').slice(1).map(JSON.parse) : [];
      // Exact evidence-text identity handles duplicates across different source questions.
      const gold = data.evidence[query.id];
      const covered = new Set(rows.map(row => data.entryKeys.get(row.id)).filter(key => gold.has(key)));
      const eligible = new Set(data.entries.slice(0, data.stats.cuts[i]).map(e => data.entryKeys.get(e.id)).filter(key => gold.has(key)));
      results.push({ id: query.id, ms, output: value ?? null, goldTurnsTotal: gold.size,
        goldTurnsEligible: eligible.size, goldTurnsLocated: covered.size });
    }
    stages.push({ compactedEntries: data.stats.cuts[i], branchEntries: branch.length, updateMs,
      firstQueryMs: cold.ms, retainedMemory, results });
  }
  console.log(JSON.stringify({ mode, round, empty, host, stats: data.stats, queries: data.queries, stages }));
} else {
  const runs = [];
  for (let round = 0; round < 3; round++) for (const mode of round % 2 ? ['index', 'scan'] : ['scan', 'index']) {
    const child = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, input, '--worker', mode, String(round)],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || `worker failed ${child.status}`);
    const result = JSON.parse(child.stdout); runs.push(result);
    console.error(`${mode} round ${round + 1} finished; ${result.stats.messages} messages`);
    // Save progress, preserving original single-question results.json untouched.
    writeFileSync(new URL('stacked-progress.json', import.meta.url), JSON.stringify(runs, null, 2) + '\n');
  }
  const expected = runs[0].stages.map(stage => new Map(stage.results.map(r => [r.id, r.output])));
  for (const run of runs) for (let i = 0; i < expected.length; i++) for (const result of run.stages[i].results) {
    if (result.output !== expected[i].get(result.id)) throw new Error(`Parity failed ${run.mode}/${i}/${result.id}`);
  }
  const report = { date: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0].model, inputSha256: hash(readFileSync(input)), repetitions: 3,
    warmupsPerStage: 1, coldRequestsPerStage: 1, measuredQueriesPerStage: 10, parity: true, runs };
  writeFileSync(new URL('stacked-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log('Saved prototype/stacked-results.json; exact parity passed for every question/stage/run');
}
