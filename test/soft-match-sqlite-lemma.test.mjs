import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createEngine } from '../benchmark/retrieval-sqlite-engine.mjs';

async function inWorker(fn) {
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    Promise.all([import(workerData.lemma),import(workerData.index)]).then(([a,b])=>(${fn.toString()})(a,b)).then(x=>parentPort.postMessage(x));`,
    {
      eval: true, workerData: {
        lemma: new URL('../prototype/soft-match-sqlite/lemma.mjs', import.meta.url).href,
        index: new URL('../prototype/soft-match-sqlite/index.mjs', import.meta.url).href
      }
    });
  try { return await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); }
  finally { await worker.terminate(); }
}


test('lemma normalized concepts retain original-form snippets and unordered co-occurrence', async () => {
  const result = await inWorker((_, { createIndex }) => {
    const documents = [{ id: 'a', text: 'noise '.repeat(40) + 'booking tickets sold better leaves' }, { id: 'b', text: 'book tickets sell good leave' },
    { id: 'c', text: 'booking noise tickets' }, { id: 'd', text: 'booked booking' }];
    const index = createIndex(documents, { arm: 'lemma-index' });
    const transformed = createIndex([{ id: 'a', text: 'noise '.repeat(40) + 'book ticket sell good leave' }, { id: 'b', text: 'book ticket sell good leave' },
    { id: 'c', text: 'book noise ticket' }, { id: 'd', text: 'book book' }]);
    try {
      const queries = [{ concepts: [['booking tickets']] }, { concepts: [['sold'], ['better']], match: 'all' }, { concepts: [['book ticket']] }];
      const rows = queries.map(query => index.queryRows(query));
      return {
        rows, actual: index.search({ concepts: [['book']] }), expected: transformed.search({ concepts: [['book']] }),
        automatic: index.search('booked booking', { automatic: true }).queryTerms
      };
    } finally { index.close(); transformed.close(); }
  });
  assert.deepEqual(result.rows[0].results.map(r => r.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(result.rows[1].results.map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(result.rows[2].results.map(r => r.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(result.actual, result.expected);
  assert.deepEqual(result.automatic, ['book']);
  assert.match(result.rows[0].results.find(r => r.id === 'a').snippet, /booking tickets/);
  assert.match(result.rows[1].results.find(r => r.id === 'a').snippet, /sold better/);
});

test('lemma engine validates concepts and off keeps exact inflections', async () => {
  const docs = [{ id: 'a', text: 'booked tickets' }, { id: 'b', text: 'book ticket' }];
  const enabled = await createEngine(docs, { arm: 'lemma-index' }), off = createEngine(docs, { arm: 'off' });
  try {
    assert.deepEqual((await enabled.search({ concepts: [['booked tickets']] })).results.map(r => r.id).sort(), ['a', 'b']);
    assert.deepEqual(off.search({ concepts: [['booked tickets']] }).results.map(r => r.id), ['a']);
    assert.deepEqual(off.search({ concepts: [['book']] }).results.map(r => r.id), ['b']);
    await assert.rejects(() => enabled.search({ concepts: [] }), { name: 'QueryError', code: 'INVALID_ARRAY' });
    await assert.rejects(() => enabled.search({ concepts: [['booking']], query: 'book' }), { name: 'QueryError', code: 'UNKNOWN_FIELD' });
  } finally { await enabled.dispose(); off.dispose(); }
});
