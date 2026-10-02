// Post-hoc analysis only. Gold labels never enter the retrieval benchmark.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
const { values: args } = parseArgs({ options: { results: { type: 'string' }, data: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
if (args.help) { console.log('Usage: node benchmark/summarize-stacked.mjs --results RESULT_JSON --data QUESTIONS_JSON --output NEW_SUMMARY_JSON'); process.exit(0); }
if (!args.results || !args.data || !args.output) throw new Error('Explicit results, data and output required');
const report = JSON.parse(readFileSync(args.results));
const questions = JSON.parse(readFileSync(args.data));
const ownGold = new Map();
for (const q of questions) {
  const ids = new Set(); let seq = 0;
  const sessions = q.haystack_sessions.map((turns, i) => ({ turns, date: q.haystack_dates[i] }))
    .sort((a, b) => a.date.replace(/ \(\w+\)/, '').localeCompare(b.date.replace(/ \(\w+\)/, '')));
  for (const { turns } of sessions) {
    if (!turns.length) continue;
    if (turns[0].role !== 'user') seq++;
    for (const turn of turns) {
      const id = `${q.question_id}:${(++seq).toString(16).padStart(8, '0')}`;
      if (turn.has_answer) ids.add(id);
    }
  }
  ownGold.set(q.question_id, ids);
}
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
const median = xs => { const sorted = [...xs].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const summary = { stats: report.runs[0].stats, node: report.node, platform: report.platform, cpu: report.cpu, parity: report.parity, arms: {}, coverage: [] };
for (const mode of ['scan', 'index']) {
  const runs = report.runs.filter(r => r.mode === mode);
  summary.arms[mode] = {
    hostHeapMiB: median(runs.map(r => (r.host.heapUsed - r.empty.heapUsed) / 2 ** 20)),
    cumulativeBuildUpdateMs: median(runs.map(r => r.stages.reduce((sum, s) => sum + s.updateMs, 0))),
    stages: [0, 1, 2].map(i => {
      const stages = runs.map(r => r.stages[i]);
      const times = stages.flatMap(s => s.results.map(r => r.ms));
      return {
        compactedEntries: stages[0].compactedEntries, measuredSamples: times.length,
        mixedMedianMs: median(times), mixedP95Ms: percentile(times, .95),
        updateMedianMs: median(stages.map(s => s.updateMs)), firstQueryMedianMs: median(stages.map(s => s.firstQueryMs)),
        additionalHeapMiB: median(runs.map(r => (r.stages[i].retainedMemory.heapUsed - r.host.heapUsed) / 2 ** 20)),
        additionalRssMiB: median(runs.map(r => (r.stages[i].retainedMemory.rss - r.host.rss) / 2 ** 20)),
        perQueryMedianMs: Object.fromEntries(report.runs[0].queries.map(q => [q.id, median(stages.map(s => s.results.find(r => r.id === q.id).ms))]))
      };
    })
  };
}
for (const stage of report.runs[0].stages) summary.coverage.push({
  compactedEntries: stage.compactedEntries,
  queries: stage.results.map(result => {
    const rows = result.output ? result.output.trim().split('\n').slice(1).map(JSON.parse) : [];
    return {
      id: result.id, eligibleGoldTurns: result.goldTurnsEligible, totalGoldTurns: result.goldTurnsTotal,
      sharedTextAwareGoldTurnsLocated: result.goldTurnsLocated,
      ownSourceGoldTurnsLocated: rows.filter(row => ownGold.get(result.id).has(row.id)).length,
      returnedIds: rows.map(row => row.id)
    };
  })
});
writeFileSync(args.output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary, null, 2));
