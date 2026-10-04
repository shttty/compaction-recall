import test from 'node:test';
import assert from 'node:assert/strict';
import { prototypeSpans, queryTerms, literalHits, prototypeWindow, productionWindow, answerPositions, visibleTerms } from '../benchmark/snippet-compare-core.mjs';

test('prototype spans retain whole ASCII identifiers and Han bigrams/word offsets across Unicode', () => {
  const text = '😀 HTTPServer snake_case 中文数据库';
  const spans = prototypeSpans(text);
  assert.deepEqual(spans.slice(0, 2).map(hit => hit.term), ['httpserver', 'snake_case']);
  for (const hit of spans) assert.equal(Array.from(text).slice(hit.start, hit.end).join('').toLowerCase(), hit.term);
  assert.ok(spans.some(hit => hit.term === '文数'));
});

test('raw native queries do not silently apply automatic Han segmentation or stopwords', () => {
  const tokenizer = text => prototypeSpans(text).map(hit => hit.term);
  assert.deepEqual(queryTerms('the 中文数据库', 'sqlite', true, tokenizer).includes('the'), false);
  assert.deepEqual(queryTerms('"coffee shop" OR 中文数据库', 'sqlite', false, tokenizer), ['coffee', 'shop', '中文数据库']);
  assert.deepEqual(queryTerms('{"queries":["coffee shop",{"queries":["the"]}]}', 'minisearch', false, tokenizer), ['coffee', 'shop', 'the']);
  assert.equal(literalHits(prototypeSpans('coffee shops'), ['shop']).length, 0);
});

test('actual prototype windows keep SQLite left context and MiniSearch case/query-order behavior', () => {
  const text = 'x'.repeat(50) + ' alpha ' + 'y'.repeat(100) + ' Beta ' + 'z'.repeat(200);
  assert.equal(prototypeWindow(text, 'Beta alpha', 'sqlite').start, 11);
  assert.equal(prototypeWindow(text, 'Beta alpha', 'minisearch').start, 158);
  assert.equal(prototypeWindow(text, 'BETA', 'minisearch').start, 0);
});

test('production window keeps rarity selection and complete-span visibility', () => {
  const text = 'a'.repeat(100) + ' common ' + 'b'.repeat(100) + ' rare ' + 'c'.repeat(100);
  const hits = [{ term: 'common', start: 101, end: 107 }, { term: 'rare', start: 209, end: 213 }];
  const window = productionWindow(text, hits, new Map([['common', 10], ['rare', 1]]));
  assert.equal(window.start, 151);
  assert.equal(visibleTerms(hits, window), 1);
  assert.equal(visibleTerms(hits, { start: 210, end: 220 }), 0);
});

test('answer positions enumerate reference phrases mechanically, preserve repeats and mark fixed supplement', () => {
  const text = 'Mango salsa, then mango salsa. Exactly two months ago.';
  const positions = answerPositions(text, 'It was mango salsa');
  assert.deepEqual(positions.map(position => position.phrase), ['mango salsa', 'mango salsa']);
  assert.equal(answerPositions(text, 'Five months ago', true).some(position => position.phrase === 'two months ago' && position.supplemental), true);
  assert.deepEqual(answerPositions('Nothing here.', 'three months'), []);
});
