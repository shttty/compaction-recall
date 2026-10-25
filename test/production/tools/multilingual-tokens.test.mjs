import '../../fixtures/isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteBackgroundIndex } from '../../../src/worker/sqlite-background-index.mjs';

const timestamp = '2026-10-12T00:00:00Z';
const msg = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
const branch = records => [...records, msg('tail', 'retained'), { type: 'compaction', id: 'c', timestamp, firstKeptEntryId: 'tail' }];

test('non-Han scripts, Japanese kana and NFKC variants are indexed instead of dropped', async () => {
  const index = new SQLiteBackgroundIndex({ jieba: false });
  const current = branch([
    msg('latin', 'Meeting at the café über alles'), msg('cyrillic', 'Привет мир'), msg('hangul', '서울에서 회의'),
    msg('japanese', '東京に行きました'), msg('halfwidth', 'ｶﾞﾗｽの窓'), msg('fullwidth', 'ＡＢＣ　ｓｅｒｖｅｒ'),
    msg('plain', 'cafe ber abc'),
  ]);
  try {
    const ids = async surface => (await index.queryPage({ concepts: [[surface]] }, current)).ids;
    assert.deepEqual(await ids('café'), ['latin']);
    assert.deepEqual(await ids('ÜBER'), ['latin']);
    assert.deepEqual(await ids('привет'), ['cyrillic']);
    assert.deepEqual(await ids('서울에서'), ['hangul']);
    assert.deepEqual(await ids('行きました'), ['japanese']);
    assert.deepEqual(await ids('ガラス'), ['halfwidth']); // Halfwidth katakana folds to fullwidth.
    assert.deepEqual((await ids('abc server')).sort(), ['fullwidth']); // Fullwidth Latin folds to ASCII.
    assert.deepEqual((await index.queryRanked('ガラス??', current)).results.map(row => row.id), ['halfwidth']);
  } finally { await index.dispose(); }
});

test('dotted runs rank exact matches first without losing partial-run fragment matches', async () => {
  const index = new SQLiteBackgroundIndex({ jieba: false });
  const current = branch([
    msg('exact', 'deploy to 10.0.0.1 done'), msg('sibling', 'deploy to 10.0.0.2 done'), msg('ten', 'version 10 released'),
    msg('domain', 'see api.irisrinne.party'), msg('fullwidth', 'ping １０．０．０．１ failed'),
  ]);
  try {
    const page = async surface => (await index.queryPage({ concepts: [[surface]] }, current)).ids;
    const exact = await page('10.0.0.1');
    assert.deepEqual(exact.slice(0, 2).sort(), ['exact', 'fullwidth']); // Exact run, including its fullwidth spelling.
    assert.deepEqual(exact.slice(2).sort(), ['sibling', 'ten']); // Fragment-only matches stay in the result set.
    assert.deepEqual((await page('10.0.0')).sort(), ['exact', 'fullwidth', 'sibling', 'ten']); // Partial run: never zero.
    assert.deepEqual(await page('irisrinne.party'), ['domain']);
    assert.deepEqual(await page('api.irisrinne.party'), ['domain']);
    const automatic = (await index.queryRanked('10.0.0.1???', current)).results.map(row => row.id);
    assert.deepEqual(automatic.slice(0, 2).sort(), ['exact', 'fullwidth']);
  } finally { await index.dispose(); }
});
