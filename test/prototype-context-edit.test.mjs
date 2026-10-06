import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { CompactionIndex } from '../archive/js-runtime/inverted-index.mjs'
import { BackgroundIndex } from '../archive/js-runtime/background-index.mjs'
import { buildLocator, buildRecallPage } from '../archive/js-runtime/locator.mjs'
import { compact, initialBranch, msg, stamp } from './corpus.mjs';

const edit = (id, target, content) => ({ type: 'context_edit', id, targetId: target.id,
  timestamp: stamp, parentId: null, replacement: content === null ? null : { content } });
const factories = {
  synchronous: () => new CompactionIndex(),
  worker: () => new BackgroundIndex(),
  fallback: () => new BackgroundIndex({ workerFactory: () => { throw new Error('fixture worker failure'); } }),
};
const recall = (index, query, branch, options = {}) => index instanceof BackgroundIndex
  ? index.query(query, branch, { mode: 'manual', options }) : index.recall(query, branch, options);
async function check(index, branch, query, ids) {
  const page = await recall(index, query, branch);
  assert.deepEqual(page, buildRecallPage(query, branch));
  assert.equal(await index.query(query, branch), buildLocator(query, branch));
  assert.equal(page.details.total, ids.length);
  const serialized = JSON.stringify(page);
  for (const id of ids) assert.ok(serialized.includes(id), `Expected ${id} in ${serialized}`);
  return serialized;
}

for (const [kind, factory] of Object.entries(factories)) {
  test(`${kind}: warm edits replace and omit history, and raw-reference branch restoration restores it`, async () => {
    const index = factory();
    const old = msg('old', 'oldmarker'), removed = msg('removed', 'omittedmarker');
    const assistant = msg('assistant', 'assistantoldmarker', 'assistant');
    const tool = msg('tool', 'toolsecretmarker', 'toolResult');
    const base = initialBranch([old, removed, assistant, tool]);
    try {
      await check(index, base, 'oldmarker', [old.id]);
      await check(index, base, 'omittedmarker', [removed.id]);
      const changed = [...base, edit('replace', old, 'newmarker'), edit('omit', removed, null),
        edit('assistant-edit', assistant, 'assistantnewmarker'), edit('tool-edit', tool, 'toolnewmarker')];
      await check(index, changed, 'oldmarker omittedmarker assistantoldmarker toolnewmarker', []);
      for (let repeat = 0; repeat < 3; repeat++) {
        const output = await check(index, changed.slice(), 'newmarker', [old.id]);
        assert.doesNotMatch(output, /oldmarker|omittedmarker/);
        assert.match(output, /newmarker/);
        await check(index, changed, 'assistantnewmarker', [assistant.id]);
      }
      const calls = [...changed, edit('latest', old, null), edit('restore', removed, [
        { type: 'toolCall', name: 'callnewmarker', arguments: { value: 'argumentnewmarker' } },
      ]), edit('assistant-call', assistant, [
        { type: 'toolCall', name: 'callnewmarker', arguments: { value: 'argumentnewmarker' } },
      ])];
      await check(index, calls, 'newmarker assistantnewmarker', []);
      await check(index, calls, 'argumentnewmarker', [assistant.id]);
      await check(index, base, 'oldmarker', [old.id]);
      await check(index, base, 'newmarker assistantnewmarker', []);
      await check(index, changed, 'oldmarker omittedmarker', []);
      assert.deepEqual(old.message.content, [{ type: 'text', text: 'oldmarker' }]);
    } finally { await index.dispose?.(); }
  });

  test(`${kind}: omitted first-kept boundary never promotes live messages`, async () => {
    const index = factory(), old = msg('old', 'historymarker');
    const kept = msg('kept', 'boundarymarker'), live = msg('later', 'livemarker');
    const base = [old, kept, live, compact('c1', kept.id)];
    try {
      await check(index, base, 'historymarker', [old.id]);
      const changed = [...base, edit('omit-boundary', kept, null)];
      await check(index, changed, 'historymarker', [old.id]);
      await check(index, changed, 'boundarymarker livemarker', []);
      const promoted = [...changed, compact('c2', live.id)];
      await check(index, promoted, 'boundarymarker livemarker', []);
    } finally { await index.dispose?.(); }
  });
}

for (const kind of ['worker', 'fallback']) {
  test(`${kind}: edited preindexed live entries use only replacements on later compaction`, async () => {
    const index = factories[kind](), old = msg('old', 'historymarker');
    const live = msg('live-edited', 'liveoldmarker', 'assistant');
    const omitted = msg('live-omitted', 'liveomittedmarker');
    const base = [...initialBranch([old]), live, omitted];
    try {
      await index.prepare(base, { preindexLive: true });
      const changed = [...base, edit('live-replace', live, 'livenewmarker'), edit('live-omit', omitted, null)];
      await index.prepare(changed, { preindexLive: true });
      await check(index, changed, 'liveoldmarker livenewmarker liveomittedmarker', []);
      const kept = msg('fresh', 'stilllivemarker');
      const promoted = [...changed, kept, compact('c2', kept.id)];
      const output = await check(index, promoted, 'livenewmarker', [live.id]);
      assert.match(output, /livenewmarker/);
      assert.doesNotMatch(output, /liveoldmarker|liveomittedmarker/);
      await check(index, promoted, 'liveoldmarker liveomittedmarker stilllivemarker', []);
      await check(index, base, 'livenewmarker liveoldmarker', []);
      await check(index, promoted, 'livenewmarker', [live.id]);
    } finally { await index.dispose(); }
  });
}

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('worker: repeated queries share edited preparation instead of cancelling it or serving stale eligibility', async () => {
  const entered = gate(), release = gate();
  let hold = false;
  const index = new BackgroundIndex({ yieldFn: async () => {
    if (hold) { entered.resolve(); await release.promise; }
    else await yieldImmediate();
  } });
  const old = msg('old', 'oldmarker'), live = msg('live', 'liveoldmarker');
  const base = initialBranch([old]);
  try {
    await index.prepare(base);
    hold = true;
    const changed = [...base, live, edit('replace', old, 'newmarker')];
    const preparing = index.prepare(changed, { preindexLive: true });
    await entered.promise;
    const first = recall(index, 'oldmarker newmarker liveoldmarker', changed);
    const second = recall(index, 'newmarker', changed.slice());
    release.resolve();
    await preparing;
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, buildRecallPage('oldmarker newmarker liveoldmarker', changed));
    assert.deepEqual(b, buildRecallPage('newmarker', changed));
    assert.equal(a.details.total, 1);
    assert.match(JSON.stringify(a), /newmarker/);
    assert.doesNotMatch(JSON.stringify(a), /oldmarker|liveoldmarker/);
  } finally { release.resolve(); await index.dispose(); }
});

test('worker: a query waiting on an obsolete preparation cannot succeed after a context edit', async () => {
  const entered = gate(), release = gate();
  let held = false;
  const index = new BackgroundIndex({ yieldFn: async () => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    else await yieldImmediate();
  } });
  const old = msg('old', 'oldmarker'), base = initialBranch([old]);
  try {
    const pending = index.query('oldmarker', base).then(
      () => 'stale success', error => error.name);
    await entered.promise;
    const changed = [...base, edit('replace', old, 'newmarker')];
    const current = index.query('newmarker', changed);
    release.resolve();
    assert.equal(await pending, 'AbortError');
    const output = await current;
    assert.equal(output, buildLocator('newmarker', changed));
    assert.match(output, /newmarker/);
    assert.doesNotMatch(output, /oldmarker/);
  } finally { release.resolve(); await index.dispose(); }
});
