import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, parseAutoGate, weightedLength } from '../archive/prototype/soft-match-sqlite/index.mjs';
import { createEngine } from '../archive/benchmark/retrieval-sqlite-engine.mjs';
import { createWorkerEngine } from '../archive/benchmark/retrieval-sqlite-worker.mjs';
import { BackgroundIndex } from '../src/background-index.mjs';
import { initialBranch, msg } from './corpus.mjs';

const engineModule = new URL('../archive/benchmark/retrieval-sqlite-worker.mjs', import.meta.url);
const text = 'alpha 网关 𠀀𠀁';
const documents = [{ id: 'match', text }];
const ids = rows => rows.map(row => row.id);
function queryAt(length, kind) {
  const base = kind === 'English' ? 'alpha' : kind === 'Han' ? '网关' : 'alpha 网关 𠀀𠀁 😀';
  const remaining = length - weightedLength(base);
  return base + (kind === 'English' ? ' '.repeat(remaining) : '中'.repeat(Math.floor(remaining / 2)) + ' '.repeat(remaining % 2));
}
function environment(t, gate) {
  const saved = process.env.COMPACTION_RECALL_AUTO_GATE;
  if (gate === undefined) delete process.env.COMPACTION_RECALL_AUTO_GATE;
  else process.env.COMPACTION_RECALL_AUTO_GATE = gate;
  t.after(() => {
    if (saved === undefined) delete process.env.COMPACTION_RECALL_AUTO_GATE;
    else process.env.COMPACTION_RECALL_AUTO_GATE = saved;
  });
}

test('gate rejects invalid configuration instead of silently changing automatic recall', t => {
  environment(t, undefined);
  assert.equal(parseAutoGate(), 210);
  assert.equal(parseAutoGate('280'), 280);
  assert.equal(parseAutoGate(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const value of ['', ' ', ' 280 ', '0', '-1', '1.5', '2.8e2', '0x118', 'Infinity', 'NaN', '9007199254740992', null, false, 0, -1, 1.5, Infinity, NaN]) {
    const expected = { name: 'RangeError', message: 'COMPACTION_RECALL_AUTO_GATE must be a positive safe integer' };
    assert.throws(() => parseAutoGate(value), expected);
    assert.throws(() => createIndex(documents, { autoGate: value }), expected);
    assert.throws(() => createEngine(documents, { arm: 'off', autoGate: value }), expected);
    assert.throws(() => createWorkerEngine({ arm: 'off', autoGate: value }), expected);
  }
  process.env.COMPACTION_RECALL_AUTO_GATE = 'invalid';
  assert.throws(() => createEngine(documents, { arm: 'off' }), /COMPACTION_RECALL_AUTO_GATE/);
  assert.throws(() => createWorkerEngine({ arm: 'off' }), /COMPACTION_RECALL_AUTO_GATE/);
});

test('Han costs two and every other Unicode codepoint costs one, including astral characters', () => {
  assert.equal(weightedLength('abc'), 3);
  assert.equal(weightedLength('网关'), 4);
  assert.equal(weightedLength('𠀀𠀁'), 4);
  assert.equal(weightedLength('😀𝒜'), 2);
  assert.equal(weightedLength('a中𠀀😀'), 6);
});

for (const gate of [210, 280]) {
  test(`automatic gate ${gate} includes its boundary, preserves manual lookup and expansion evidence`, t => {
    environment(t, gate === 210 ? undefined : '280');
    const index = createIndex(documents, gate === 210 ? {} : { autoGate: gate });
    const old = createIndex(documents);
    t.after(() => { index.close(); old.close(); });
    for (const kind of ['English', 'Han', 'mixed']) {
      for (const length of [gate - 1, gate, gate + 1]) {
        const query = queryAt(length, kind);
        assert.equal(weightedLength(query), length);
        const automatic = index.search(query, { automatic: true });
        assert.equal(automatic.skipped, length > gate, `${kind} ${length}`);
        assert.deepEqual(ids(automatic.results), length > gate ? [] : ['match']);
        assert.deepEqual(ids(index.search({ concepts: [['alpha' + ' '.repeat(length - 5)]] }).results), ['match']);
        assert.deepEqual(ids(index.search({ concepts: [['网关' + ' '.repeat(length - 4)]] }).results), ['match']);
        assert.equal(index.expansionTerms(query).some(({ term }) => term === (kind === 'Han' ? '网关' : 'alpha')), length <= gate);
      }
    }
    const content = [{ type: 'text', text: queryAt(gate, 'mixed') }, { type: 'image', data: 'ignored' }];
    assert.deepEqual(ids(index.search(content, { automatic: true }).results), ['match']);
    assert.equal(index.search([...content, { type: 'text', text: 'a' }], { automatic: true }).skipped, true);
    // createIndex has no ambient environment configuration; factories pass it explicitly.
    assert.equal(old.search(queryAt(211, 'English'), { automatic: true }).skipped, true);
  });
}
test('factories capture environment gate once and preserve it across worker corpus rebuilds', async t => {
  environment(t, '280');
  const sync = createEngine(documents, { arm: 'off', execution: 'sync' });
  const threadedPromise = createEngine(documents, { arm: 'off', execution: 'worker' });
  const worker = createWorkerEngine({ arm: 'off' });
  process.env.COMPACTION_RECALL_AUTO_GATE = '1';
  const threaded = await threadedPromise;
  t.after(async () => { sync.dispose(); worker.dispose(); await threaded.dispose(); });
  const entries = [{ id: 'match', sourcePosition: 0, timestamp: '2026-10-04T00:00:00Z', message: { role: 'user', content: text } }];
  worker.commit(entries, { eligibleCount: 1 });
  for (const length of [279, 280, 281]) {
    const query = queryAt(length, 'mixed');
    const expected = length <= 280 ? ['match'] : [];
    assert.deepEqual(ids(sync.searchAuto(query)), expected);
    assert.deepEqual(await threaded.searchAuto(query), sync.searchAuto(query));
    assert.deepEqual(worker.query(query, { mode: 'auto' }).results.map(({ id, score }) => ({ id, score })), sync.searchAuto(query));
  }
  worker.commit([{ ...entries[0], message: { role: 'user', content: text + ' changed' } }], { eligibleCount: 1 });
  assert.deepEqual(ids(worker.query(queryAt(280, 'English'), { mode: 'auto' }).results), ['match']);
  assert.deepEqual(ids(sync.search({ concepts: [[queryAt(281, 'English')]] }).results), ['match']);
  assert.deepEqual(ids((await threaded.search({ concepts: [[queryAt(281, 'English')]] })).results), ['match']);
});

for (const gate of [210, 280]) {
  test(`shared BackgroundIndex and synchronous evaluation produce identical results at gate ${gate}`, async t => {
    environment(t, gate === 210 ? undefined : '280');
    const branch = initialBranch([{ ...msg('match', text), id: 'match' }]);
    const background = new BackgroundIndex({ engineModule });
    const sync = createEngine(documents, { arm: 'off', execution: 'sync' });
    t.after(async () => { sync.dispose(); await background.dispose(); });
    await background.prepare(branch, { preindexLive: true });
    process.env.COMPACTION_RECALL_AUTO_GATE = '1';
    for (const kind of ['English', 'Han', 'mixed']) {
      for (const length of [gate - 1, gate, gate + 1]) {
        const query = queryAt(length, kind);
        const found = await background.queryRanked(query, branch, { mode: 'auto' });
        assert.deepEqual(found.results.map(({ id, score }) => ({ id, score })), sync.searchAuto(query));
        assert.deepEqual(ids(found.results), length <= gate ? ['match'] : []);
      }
    }
    const manual = await background.queryRanked({ concepts: [[queryAt(gate + 1, 'English')]] }, branch, { mode: 'manual' });
    assert.deepEqual(manual.results.map(({ id, score }) => ({ id, score })), sync.search({ concepts: [[queryAt(gate + 1, 'English')]] }).results);
    assert.deepEqual(ids(manual.results), ['match']);
  });
}
