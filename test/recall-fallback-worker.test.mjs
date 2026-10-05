import './isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundIndex } from '../src/background-index.mjs';
import { SQLiteBackgroundIndex } from '../benchmark/sqlite-background-index.mjs';
import { compact, initialBranch, msg, stamp } from './corpus.mjs';

const engineModule = new URL('../benchmark/retrieval-sqlite-worker.mjs', import.meta.url);
const ids = found => found.results.map(row => row.id);
const query = (concepts, match = 'any', exclude = []) => ({ concepts, match, exclude });
const edit = (id, targetId, content) => ({ type: 'context_edit', id, targetId, timestamp: stamp,
  replacement: content === null ? null : { content } });
const recall = (index, input, branch) => index.queryRanked(input, branch, { mode: 'manual' });
function scores(found, expected) {
  assert.deepEqual(ids(found), expected.map(([id]) => id));
  for (const [at, [, score]] of expected.entries()) {
    assert.ok(Math.abs(found.results[at].score - score) < 1e-12,
      `${found.results[at].id}: expected ${score}, got ${found.results[at].score}`);
  }
}
function fallback(found, surfaces, scannedDocuments) {
  assert.deepEqual(found.fallback, { surfaces, scannedDocuments, ranking: 'rarity' });
}

for (const Engine of [BackgroundIndex, SQLiteBackgroundIndex]) {
  test(`${Engine.name}: any unions FTS hits with literal-only evidence; all, alternatives and exclusions use eligible DF`, async t => {
    const index = new Engine({ engineModule });
    t.after(() => index.dispose());
    const branch = initialBranch([
      msg('both', 'alpha 中 red'), msg('fts', 'alpha blue'), msg('literal', '中'),
      msg('alternative', 'alpha beta 中 amber'), msg('blocked', 'alpha 中 x'), msg('none', 'gamma none'),
    ]);
    // Six eligible rows: alpha DF=4, 中 DF=4, beta DF=1, x DF=1.
    // These fixed examples are hand-counted before match/all/exclude/paging.
    const common = 1 + Math.log(7 / 5), rare = 1 + Math.log(7 / 2);
    const pure = await recall(index, query([['alpha']]), branch);
    assert.deepEqual(ids(pure).slice().sort(), ['malternative', 'mblocked', 'mboth', 'mfts']);
    assert.equal(Object.hasOwn(pure, 'fallback'), false);
    const missing = await recall(index, query([['missingword']]), branch);
    assert.equal(missing.total, 0);
    assert.equal(Object.hasOwn(missing, 'fallback'), false);

    const any = await recall(index, query([['alpha'], ['中']]), branch);
    assert.equal(any.total, 5);
    scores(any, [['mblocked', 2 * common], ['malternative', 2 * common], ['mboth', 2 * common],
      ['mliteral', common], ['mfts', common]]);
    fallback(any, ['中'], 6);
    assert.ok(any.results.find(row => row.id === 'mliteral').snippet.includes('中'));

    const all = await recall(index, query([['alpha', 'beta'], ['中']], 'all', ['x']), branch);
    scores(all, [['malternative', rare + common], ['mboth', 2 * common]]);
    assert.equal(all.total, 2);
    fallback(all, ['中', 'x'], 6);
    // The alternative row contains both alpha and beta: only beta's larger
    // weight contributes to their group, never alpha+beta together.
    const mixedAlternative = await recall(index, query([['alpha', '中']], 'all'), branch);
    scores(mixedAlternative, [['mblocked', common], ['malternative', common], ['mliteral', common],
      ['mfts', common], ['mboth', common]]);
    const excluded = await recall(index, query([['alpha']], 'any', ['中']), branch);
    scores(excluded, [['mfts', common]]);
    fallback(excluded, ['中'], 6);
    const literal = await recall(index, query([['中']], 'any', ['x']), branch);
    scores(literal, [['malternative', common], ['mliteral', common], ['mboth', common]]);
    fallback(literal, ['中', 'x'], 6);
    assert.equal((await recall(index, query([['中'], ['x']], 'all', ['x']), branch)).total, 0);
  });

  test(`${Engine.name}: live, hidden blocks and edited originals cannot widen N/DF; compaction, fork, reset and dispose stay isolated`, async t => {
    const index = new Engine({ engineModule });
    t.after(() => index.dispose());
    const old = msg('old', 'alpha 中'), other = msg('other', 'beta background');
    const omitted = msg('omitted', 'alpha 中 x');
    const visible = msg('visible', 'gamma visible', 'assistant');
    visible.message.content.push({ type: 'thinking', thinking: '中 x hiddenoriginal', text: '中 x hiddenoriginal' },
      { type: 'image', data: '中 x hiddenoriginal', text: '中 x hiddenoriginal' });
    const live = msg('live-marker', 'alpha 中 x liveoriginal');
    const tool = msg('tool', 'alpha 中 x tooloriginal', 'toolResult');
    const custom = { type: 'custom_message', id: 'custom', timestamp: stamp, content: 'alpha 中 x customoriginal' };
    const branch = [old, other, omitted, visible, tool, custom, live, compact('c1', live.id)];
    const input = query([['alpha'], ['中']]);
    await index.prepare(branch, { preindexLive: true });
    const baseline = await recall(index, input, branch);
    const initialWeight = 1 + Math.log(5 / 3); // N=4, both positive surfaces DF=2.
    scores(baseline, [['momitted', 2 * initialWeight], ['mold', 2 * initialWeight]]);
    fallback(baseline, ['中'], 4);
    const preindexed = [...branch, msg('live-extra', 'alpha 中 x liveextra')];
    await index.prepare(preindexed, { preindexLive: true });
    assert.deepEqual(await recall(index, input, preindexed), baseline);

    const changed = [...branch, edit('replace-old', old.id, 'alpha replacement'),
      edit('omit-old', omitted.id, null), edit('replace-live', live.id, 'beta live-replacement')];
    await index.prepare(changed, { preindexLive: true });
    const edited = await recall(index, input, changed);
    scores(edited, [['mold', 1 + Math.log(4 / 2)]]); // N=3, alpha DF=1; raw 中 vanished.
    fallback(edited, ['中'], 3);
    for (const surface of ['中', 'x', 'hiddenoriginal', 'liveoriginal', 'tooloriginal', 'customoriginal']) {
      assert.equal((await recall(index, query([[surface]]), changed)).total, 0, surface);
    }
    const kept = msg('kept', 'alpha 中 x retained');
    const promoted = [...changed, kept, compact('c2', kept.id)];
    const activated = await recall(index, query([['beta'], ['x']]), promoted);
    scores(activated, [[live.id, 1 + Math.log(5 / 3)], [other.id, 1 + Math.log(5 / 3)]]);
    fallback(activated, ['x'], 4);
    assert.equal((await recall(index, query([['中']]), promoted)).total, 0);
    assert.equal((await recall(index, query([['liveoriginal']]), promoted)).total, 0);
    // Omitting the retained boundary does not accidentally activate its raw text.
    const omittedBoundary = [...promoted, edit('omit-boundary', kept.id, null)];
    assert.equal((await recall(index, query([['中']]), omittedBoundary)).total, 0);
    fallback(await recall(index, query([['x']]), omittedBoundary), ['x'], 4);

    const previousWorker = index.worker;
    await index.reset();
    const fork = initialBranch([msg('fork', 'x fork evidence')]);
    const fresh = await recall(index, query([['x']]), fork);
    scores(fresh, [['mfork', 1]]);
    fallback(fresh, ['x'], 1);
    assert.notEqual(index.worker, previousWorker);
    assert.equal((await recall(index, query([['中']]), fork)).total, 0);
    await index.dispose();
    await assert.rejects(recall(index, query([['x']]), fork), { name: 'AbortError' });
    await index.reset();
    scores(await recall(index, query([['x']]), fork), [['mfork', 1]]);
  });

  test(`${Engine.name}: literal Unicode matches anchor original-case snippets after astral and length-changing lowercase prefixes`, async t => {
    const index = new Engine({ engineModule, snippetBudget: 80 });
    t.after(() => index.dispose());
    const text = '🙂İ𠀁'.repeat(150) + 'padding '.repeat(100) + 'before c++ Δ after ' + 'trailing '.repeat(100);
    const branch = initialBranch([msg('unicode', text), msg('only-ascii', 'C plus delta')]);
    const found = await recall(index, query([['C++'], ['δ']], 'all'), branch);
    scores(found, [['municode', 2 * (1 + Math.log(3 / 2))]]);
    fallback(found, ['C++', 'δ'], 2);
    assert.match(found.results[0].snippet, /c\+\+ Δ/);
    assert.ok(text.includes(found.results[0].snippet.replace(/^…|…$/gu, '')));
  });

  test(`${Engine.name}: full hybrid ranking and page union retain content dedupe after row-level DF`, async t => {
    const index = new Engine({ engineModule });
    t.after(() => index.dispose());
    const rows = Array.from({ length: 11 }, (_, i) => msg(i, `alpha 中 row${i}`));
    rows.push({ ...msg('duplicate', 'alpha   中 row10'), timestamp: '2026-10-06T00:00:00.000Z' },
      msg('fts', 'alpha english'), msg('literal', '中 symbol'));
    const branch = initialBranch(rows), input = query([['alpha'], ['中']]);
    // N=14 includes both hash-equivalent rows; alpha and 中 each have DF=13.
    // Dedupe is after scoring, yielding 13 representatives, not N=13 or DF=12.
    const weight = 1 + Math.log(15 / 14);
    const expected = ['mduplicate', ...Array.from({ length: 10 }, (_, i) => `m${9 - i}`), 'mliteral', 'mfts'];
    const ranked = await recall(index, input, branch);
    assert.equal(ranked.total, 13);
    scores(ranked, expected.map((id, at) => [id, at < 11 ? 2 * weight : weight]));
    fallback(ranked, ['中'], 14);
    const collected = [];
    for (let offset = 0; offset < 13; offset += 3) {
      const page = Engine === SQLiteBackgroundIndex
        ? await index.queryPage(input, branch, { limit: 3, offset })
        : await index.queryRanked(input, branch, { mode: 'manual', options: { page: true, limit: 3, offset } });
      assert.equal(page.total, 13);
      assert.equal(page.page.details.total, 13);
      fallback(page, ['中'], 14);
      assert.deepEqual(page.ids, expected.slice(offset, offset + 3));
      collected.push(...page.ids);
    }
    assert.deepEqual(collected, expected);
    const beyond = await index.queryRanked(input, branch, { mode: 'manual', options: { page: true, limit: 3, offset: 99 } });
    assert.equal(beyond.total, 13);
    assert.deepEqual(beyond.ids, []);
    fallback(beyond, ['中'], 14);
  });
}
