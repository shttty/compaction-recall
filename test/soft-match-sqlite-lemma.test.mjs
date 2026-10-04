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

test('single lemma uses verb then noun then adjective first change; native query syntax stays valid', async () => {
  const result = await inWorker(({ createLemmaNormalizer }) => {
    const { normalize, expression } = createLemmaNormalizer();
    return {
      terms: ['booking', 'leaves', 'sold', 'better', 'attendance', 'booked', 'children', 'attended', 'workshops', 'book_ings', 'book2', '预约'].map(normalize),
      expressions: ['booking AND sold', '"booking tickets" OR sold', 'booking* OR "booking tickets"*',
        'NEAR(booking sold, 2)', 'tokens:"booking tickets"', '{tokens}:booking', '"book_ings"', '"'].map(expression),
    };
  });
  assert.deepEqual(result.terms, ['book', 'leave', 'sell', 'good', 'attendance', 'book', 'child', 'attend', 'workshop', 'book_ings', 'book2', '预约']);
  assert.deepEqual(result.expressions, ['book AND sell', '"book ticket" OR sell', 'booking* OR "book tickets"*',
    'NEAR(book sell, 2)', 'tokens:"book ticket"', '{tokens}:book', '"book_ings"', '"']);
});

test('lemma phrase positions, one normalized vocabulary score, and original-form snippets', async () => {
  const result = await inWorker((_, { createIndex }) => {
    const documents = [{ id: 'a', text: 'noise '.repeat(40) + 'booking tickets sold better leaves' }, { id: 'b', text: 'book tickets sell good leave' },
    { id: 'c', text: 'booking noise tickets' }, { id: 'd', text: 'booked booking' }];
    const index = createIndex(documents, { arm: 'lemma-index' });
    const transformed = createIndex([{ id: 'a', text: 'noise '.repeat(40) + 'book ticket sell good leave' }, { id: 'b', text: 'book ticket sell good leave' },
    { id: 'c', text: 'book noise ticket' }, { id: 'd', text: 'book book' }]);
    try {
      const queries = ['"booked tickets"', 'sold AND better', 'NEAR(booking tickets, 1)', 'tokens:"booking tickets"', 'booking*'];
      const rows = queries.map(query => index.queryRows(query));
      return {
        rows, actual: index.searchRaw('book'), expected: transformed.searchRaw('book'),
        automatic: index.search('booked booking', { automatic: true }).queryTerms,
        missing: index.missingTerms('sold better booked')
      };
    } finally { index.close(); transformed.close(); }
  });
  assert.deepEqual(result.rows[0].results.map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(result.rows[1].results.map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(result.rows[2].results.map(r => r.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(result.rows[3].results.map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(result.rows[4].results, []);
  assert.deepEqual(result.actual, result.expected);
  assert.deepEqual(result.automatic, ['book']);
  assert.deepEqual(result.missing, []);
  assert.match(result.rows[0].results.find(r => r.id === 'a').snippet, /booking tickets/);
  assert.match(result.rows[1].results.find(r => r.id === 'a').snippet, /sold better/);
});

test('lemma engine preserves original errors and off exact inflection behavior', async () => {
  const docs = [{ id: 'a', text: 'booked tickets' }, { id: 'b', text: 'book ticket' }];
  const enabled = await createEngine(docs, { arm: 'lemma-index' }), off = createEngine(docs, { arm: 'off' });
  try {
    assert.deepEqual((await enabled.searchRaw('"booked tickets"')).results.map(r => r.id).sort(), ['a', 'b']);
    assert.deepEqual(off.searchRaw('"booked tickets"').results.map(r => r.id), ['a']);
    assert.deepEqual(off.searchRaw('book').results.map(r => r.id), ['b']);
    await assert.rejects(() => enabled.searchRaw('"'), /unterminated/);
    await assert.rejects(() => enabled.searchRaw('unknown:booking'), /no such column/);
  } finally { await enabled.dispose(); off.dispose(); }
});
