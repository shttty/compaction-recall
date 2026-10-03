import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const directory = path.resolve(process.argv[2] ?? 'benchmark/results/index-alt-20261003');
const variants = ['base', 'A', 'B1', 'B2', 'B3'], sizes = [50000, 200000, 500000, 1000000];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const MiB = n => n / 1048576;
const cpus = value => value.split(',').flatMap(part => {
  const [first, last = first] = part.split('-').map(Number);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}).sort((a, b) => a - b);
const runs = [];
for (const size of sizes) for (const variant of variants) for (let repetition = 1; repetition <= 3; repetition++) {
  const run = read(path.join(directory, 'matrix', `${size}-${variant}-r${repetition}.json`));
  assert.equal(run.shutdown, 'completed'); assert.equal(run.stderr, ''); assert.equal(run.timingEnabled, false);
  assert.equal(run.diskWriteBytes, 0); assert.equal(run.incremental.value.append, true);
  assert.deepEqual(cpus(run.affinity), cpus(run.cpuMask));
  const expectedQueries = 42 + ['initial', 'updated'].reduce((sum, phase) =>
    sum + run[phase].length + run[phase].reduce((n, query) => n + query.pages.length, 0), 0);
  assert.equal(run.workerQueryReplies, expectedQueries, 'Every measured lookup must use the worker');
  runs.push(run);
}
const cells = sizes.flatMap(size => variants.map(variant => {
  const rs = runs.filter(r => r.stats.targetTokens === size && r.variant === variant);
  const m = get => median(rs.map(get));
  return {
    targetTokens: size, variant, actualTokens: rs[0].stats.actualTokens,
    rssMiB: MiB(m(r => r.memory.sharedProcessRssBytes)), mainHeapMiB: MiB(m(r => r.memory.mainHeapUsedBytes)),
    workerHeapMiB: MiB(m(r => r.memory.worker.heap.used_heap_size)), workerExternalMiB: MiB(m(r => r.memory.worker.heap.external_memory)),
    storageAllocatedMiB: variant === 'base' ? null : MiB(m(r => r.memory.storageAtCommit.allocatedTypedBytes ?? r.memory.storageAtCommit.sqlitePageBytes)),
    buildMs: m(r => r.build.wallMs), maxDelayMs: m(r => r.build.maxEventLoopDelayMs),
    contextP50Ms: m(r => r.warmContext.p50Ms), contextP95Ms: m(r => r.warmContext.p95Ms),
    recallP50Ms: m(r => r.warmRecall.p50Ms), recallP95Ms: m(r => r.warmRecall.p95Ms), incrementalMs: m(r => r.incremental.wallMs),
    rssRangeMiB: [Math.min(...rs.map(r => MiB(r.memory.sharedProcessRssBytes))), Math.max(...rs.map(r => MiB(r.memory.sharedProcessRssBytes)))],
    peakRssMiB: m(r => r.peakRssKiB / 1024),
    queryCount: rs[0].initial[0].pages[0].total,
  };
}));
const parity = Object.fromEntries(variants.slice(1).map(v => [v, {
  cases: 0, exact: 0, autoExact: 0, pagesExact: 0,
  totalPages: 0, pageHashesExact: 0, differences: [], top5Intersection: 0, top5Denominator: 0,
  top50Intersection: 0, top50Denominator: 0, emptyBaseCases: 0, newHitsOnEmptyBase: 0
}]));
for (const candidate of runs.filter(r => r.variant !== 'base')) {
  const base = runs.find(r => r.variant === 'base' && r.stats.targetTokens === candidate.stats.targetTokens && r.repetition === candidate.repetition);
  const result = parity[candidate.variant];
  for (const phase of ['initial', 'updated']) for (let i = 0; i < base[phase].length; i++) {
    const b = base[phase][i], c = candidate[phase][i]; assert.equal(b.query, c.query);
    const autoSame = b.autoText === c.autoText, pagesSame = JSON.stringify(b.pages) === JSON.stringify(c.pages);
    result.cases++; result.autoExact += Number(autoSame); result.pagesExact += Number(pagesSame);
    result.exact += Number(autoSame && pagesSame); result.totalPages += b.pages.length;
    result.pageHashesExact += b.pages.filter((p, j) => c.pages[j]?.sha256 === p.sha256).length;
    for (const n of [5, 50]) {
      const bi = b.topIds.slice(0, n), ci = new Set(c.topIds.slice(0, n));
      result[`top${n}Intersection`] += bi.filter(id => ci.has(id)).length;
      result[`top${n}Denominator`] += bi.length;
    }
    if (!b.topIds.length) { result.emptyBaseCases++; result.newHitsOnEmptyBase += Number(c.topIds.length > 0); }
    if (!autoSame || !pagesSame) result.differences.push({
      targetTokens: candidate.stats.targetTokens, repetition: candidate.repetition,
      phase, query: b.query, autoSame, pagesSame, baseTotal: b.pages[0].total, alternativeTotal: c.pages[0].total,
      baseTop5: b.topIds.slice(0, 5), alternativeTop5: c.topIds.slice(0, 5)
    });
  }
}
for (const result of Object.values(parity)) {
  result.exactFraction = result.exact / result.cases;
  result.top5Coverage = result.top5Intersection / result.top5Denominator;
  result.top50Coverage = result.top50Intersection / result.top50Denominator;
}
for (const variant of ['A', 'B1']) assert.equal(parity[variant].exact, parity[variant].cases);
const events = runs.flatMap(r => [{ at: Date.parse(r.startedAt), delta: 1 }, { at: Date.parse(r.finishedAt), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
let concurrent = 0, maximumConcurrent = 0;
for (const event of events) { concurrent += event.delta; maximumConcurrent = Math.max(maximumConcurrent, concurrent); }
const matrixMetadata = read(path.join(directory, 'matrix', 'lane-0-metadata.json'));
assert.ok(maximumConcurrent <= matrixMetadata.actualParallelism && maximumConcurrent <= 5);
const waves = sizes.flatMap(size => [...new Set(runs.filter(r => r.stats.targetTokens === size).map(r => r.wave))].map(wave => ({
  size, wave,
  jobs: runs.filter(r => r.stats.targetTokens === size && r.wave === wave).map(r => ({
    variant: r.variant, lane: r.lane, repetition: r.repetition,
    cpuMask: r.cpuMask, startedAt: r.startedAt, finishedAt: r.finishedAt,
    measurementStartEpochMs: r.timeOriginMs + r.build.startMs, hotRecallStartEpochMs: r.timeOriginMs + r.warmRecall.startMs
  }))
})));
for (const wave of waves) {
  if (matrixMetadata.actualParallelism !== 5) continue;
  assert.deepEqual(wave.jobs.map(job => job.variant).sort(), [...variants].sort());
  assert.equal(new Set(wave.jobs.map(job => job.repetition)).size, 1);
  assert.equal(new Set(wave.jobs.map(job => job.cpuMask)).size, 5);
}
const timing = {};
for (const variant of variants) {
  const run = read(path.join(directory, 'timing', `1000000-${variant}-r1.json`));
  const events = fs.readFileSync(path.join(directory, 'timing', run.timingFile), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(fs.statSync(path.join(directory, 'timing', run.timingFile)).mode & 0o777, 0o600);
  const workerSpans = events.filter(event => event.type === 'span' && event.execution === 'worker_thread').length;
  assert.ok(workerSpans > 0);
  const phases = {};
  for (const phase of ['build', 'warmContext', 'warmRecall', 'incremental']) {
    const stages = {};
    for (const event of events) {
      const at = event.clockOriginMs + event.startMs;
      if (event.type !== 'span' || at < run[phase].startMs || at > run[phase].endMs || !Number.isFinite(event.durationMs)) continue;
      (stages[event.stage] ??= []).push(event.durationMs);
    }
    phases[phase] = Object.fromEntries(Object.entries(stages).map(([stage, values]) => [stage,
      { count: values.length, totalMs: values.reduce((a, b) => a + b, 0), meanMs: values.reduce((a, b) => a + b, 0) / values.length, p50Ms: median(values) }]));
  }
  timing[variant] = {
    diagnosticRuns: 1, workerSpans, warmRecallP50Ms: run.warmRecall.p50Ms,
    stages: phases.warmRecall, phases
  };
  for (const stage of ['postings_search', 'candidate_materialization', 'manual_snippets_pagination_render']) assert.equal(timing[variant].stages[stage]?.count, 20, `${variant}: ${stage} window`);
}
const semanticRuns = Object.fromEntries(variants.map(variant => [variant,
  read(path.join(directory, 'smoke', `semantic-${variant}-r1.json`))]));
const semantics = semanticRuns.B3.semanticCases.map((spec, i) => {
  for (const [phase, key] of [['initial', 'expectedB3HitIds'], ['updated', 'expectedB3IncrementalHitIds']]) {
    assert.deepEqual([...semanticRuns.B3[phase][i].topIds].sort(), [...spec[key]].sort(), `${phase}: ${spec.query}`);
  }
  const ids = semanticRuns.B3.initial[i].topIds, primary = new Set(spec.expectedB3PrimaryHitIds);
  let secondarySeen = false;
  for (const id of ids) {
    if (primary.has(id)) assert.equal(secondarySeen, false, 'Lexical tier must precede substring-only hits');
    else secondarySeen = true;
  }
  return {
    ...spec, results: Object.fromEntries(variants.map(v => [v, {
      initial: semanticRuns[v].initial[i].topIds, updated: semanticRuns[v].updated[i].topIds,
      autoInitial: semanticRuns[v].initial[i].autoIds,
    }]))
  };
});
const compatibility = [];
for (const variant of ['B1', 'B2', 'B3']) for (const size of ['semantic', 50000]) {
  const run = read(path.join(directory, 'node26', `${size}-${variant}-r1.json`));
  const baseline = read(path.join(directory, 'smoke', `${size}-${variant}-r1.json`));
  assert.equal(run.stderr, ''); assert.equal(run.diskWriteBytes, 0); assert.equal(run.shutdown, 'completed');
  for (const phase of ['initial', 'updated']) for (let i = 0; i < baseline[phase].length; i++) {
    assert.equal(run[phase][i].autoText, baseline[phase][i].autoText);
    assert.deepEqual(run[phase][i].pages, baseline[phase][i].pages);
  }
  compatibility.push({ variant, size, runtime: run.runtime, outputMatchesNode24: true, stderr: run.stderr, diskWriteBytes: run.diskWriteBytes });
}
const npm = read(path.join(directory, 'npm-layout.json'));
const summary = {
  cells, parity, timing, semantics, compatibility,
  concurrency: { maximumConcurrent, masks: matrixMetadata.masks, memoryPlan: matrixMetadata.memoryPlan, waves },
  methods: {
    aggregates: 'median across three fresh processes; p50/p95 nearest-rank across 20 hot operations inside each process',
    topN: 'intersection / number of base top-N ids, micro-weighted; empty base cases excluded and counted separately',
    memory: 'same point as perf scaling: main GC after one context query; worker stats separately sampled without worker GC; no per-thread RSS exists',
    stages: 'one separate timing-enabled 1M process per variant; phase start windows; mean per event, total per phase; inclusive nested spans, not additive',
  }, npmLayout: { runs: npm.runs.map(r => ({ node: r.node, ...r.checks, stderr: r.stderr, workerQuerySpans: r.workerQuerySpans })), scratchRemoved: npm.scratchRemoved }
};
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ cells: cells.filter(c => c.targetTokens === 1000000), parity: Object.fromEntries(Object.entries(parity).map(([v, p]) => [v, { exact: p.exact, cases: p.cases, top5Coverage: p.top5Coverage, top50Coverage: p.top50Coverage, differences: p.differences.length }])), maximumConcurrent, timing }, null, 2));
