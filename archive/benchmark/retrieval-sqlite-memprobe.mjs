// Run each arm/corpus in a fresh `node --expose-gc` process. No model calls.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { loadEvaluationCases } from '../../benchmark/retrieval-eval-core.mjs';
import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';
import { createTokenizer, validateArm } from '../prototype/soft-match-sqlite/arms.mjs';

if (isMainThread) {
  if (typeof global.gc !== 'function') throw new Error('Required: node --expose-gc');
  const { values } = parseArgs({ options: Object.fromEntries(['arm', 'data', 'gold', 'question', 'language'].map(name => [name, { type: 'string' }])) });
  for (const name of ['data', 'gold', 'question', 'language']) if (!values[name]) throw new Error(`Explicit --${name} required`);
  values.arm = validateArm(values.arm ?? 'off');
  const worker = new Worker(new URL(import.meta.url), { workerData: values, execArgv: [] });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Memory probe exited ${code}`)); });
    });
    console.log(JSON.stringify(result));
  } finally { await worker.terminate(); }
} else {
  if (typeof global.gc !== 'function') throw new Error('GC is not exposed inside worker');
  const { arm, data, gold, question: key, language } = workerData;
  let cases = loadEvaluationCases({ dataRoot: data, goldPath: gold });
  let selected = cases.find(row => row.key === key && row.language === language);
  if (!selected) throw new Error(`Missing ${key} ${language}`);
  const documents = selected.documents, question = selected.question;
  selected = null; cases = null;
  const snap = () => { global.gc(); global.gc(); return process.memoryUsage(); };
  const beforeLoad = snap();
  const loadStart = performance.now();
  createTokenizer(arm); // native dictionary initialization only here, once per worker
  const tokenizerLoadMs = performance.now() - loadStart;
  const before = snap();
  const start = performance.now();
  const index = createIndex(documents, { arm });
  const buildMs = performance.now() - start;
  const after = snap();
  const probes = language === 'en'
    ? [['auto', question], ['auto', 'classes workshops'], ['manual', 'classes workshops'], ['manual', 'attended workshop'], ['manual', '"art class"']]
    : [['auto', question], ['auto', '艺术课程'], ['manual', '艺术 课程'], ['manual', '学习 参加'], ['manual', '"艺术"']];
  const queries = [];
  try {
    for (const [mode, query] of probes) {
      const samples = [];
      let total;
      for (let run = 0; run < 4; run++) {
        const at = performance.now();
        const found = index.queryRows(query, { mode });
        samples.push(performance.now() - at); total = found.total;
      }
      const warm = samples.slice(1).sort((a, b) => a - b);
      queries.push({ mode, query, total, coldMs: samples[0], warmMedianMs: warm[1], samplesMs: samples });
    }
    parentPort.postMessage({
      arm, key, language, documents: documents.length, indexedDocuments: index.size,
      characters: documents.reduce((sum, doc) => sum + Array.from(doc.text).length, 0), node: process.version,
      execution: 'synchronous index inside fresh worker', gc: 'twice before/after load and build',
      tokenizerLoadMs, jiebaLoadRssDeltaBytes: arm === 'jieba' ? before.rss - beforeLoad.rss : 0,
      buildMs, liveHeapDeltaBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss,
      inflections: index.inflectionStats(),
      beforeLoad, before, after, queries
    });
  } finally { index.close(); }
}
