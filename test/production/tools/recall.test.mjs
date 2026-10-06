import '../../fixtures/isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import test from 'node:test';
import register from '../../../src/index.ts';
import { compactedEntries, entryText, MAX_EXPAND_CHARS } from '../../../src/history/history.mjs';
import { RECALL_PAGE_CHARS } from '../../../src/history/locator.mjs';

const stamp = '2026-09-30T00:00:00.000Z';
const msg = (id, text, role = 'user') => ({
  type: 'message', id, timestamp: stamp,
  parentId: null, message: { role, content: [{ type: 'text', text }], timestamp: 0 }
});
const compact = (id, firstKeptEntryId) => ({
  type: 'compaction', id, timestamp: stamp,
  parentId: null, firstKeptEntryId, summary: 'not searchable summary', tokensBefore: 100
});
const text = (result) => result.content[0].text;
const activeHarnesses = new Set();
afterEach(async () => {
  for (const close of activeHarnesses) await close();
  activeHarnesses.clear();
});
function harness(initial) {
  let branch = initial;
  const tools = new Map();
  const hooks = new Map();
  const ctx = { sessionManager: { getBranch: () => branch } };
  register({ registerTool: (tool) => tools.set(tool.name, tool), on: (event, handler) => hooks.set(event, handler) });
  activeHarnesses.add(() => hooks.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, ctx));
  return {
    tools, setBranch: (value) => { branch = value; },
    run: (name, params) => tools.get(name).execute('test', params, undefined, undefined, ctx),
    async auto(query) {
      const result = await hooks.get('context')({ messages: [{ role: 'user', content: query, timestamp: 0 }] }, ctx);
      return result.messages.find(message => message.role === 'custom')?.content;
    }
  };
}

test('no compaction, latest boundary, repeated compaction and missing boundary', () => {
  const a = msg('a', 'old'), b = msg('b', 'retained tail'), c = msg('c', 'live');
  assert.deepEqual(compactedEntries([a, b]), []);
  assert.deepEqual(compactedEntries([a, b, compact('c1', 'b')]).map(e => e.id), ['a']);
  assert.deepEqual(compactedEntries([a, b, compact('c1', 'b'), c, compact('c2', 'c')]).map(e => e.id), ['a', 'b']);
  assert.deepEqual(compactedEntries([a, b, compact('c1', 'missing'), c]).map(e => e.id), ['a', 'b']);
});

test('readable text includes raw tool output but ignores hidden blocks and malformed user calls', () => {
  const e = msg('a', 'body');
  e.message.content.push({ type: 'thinking', thinking: 'secret thought' },
    { type: 'toolCall', name: 'bash', arguments: { command: 'hidden arguments' } },
    { type: 'image', data: 'hidden image' }, { type: 'text', text: 'second' });
  assert.equal(entryText(e), 'body\nsecond');
  e.message.content = 'string body';
  assert.equal(entryText(e), 'string body');
  assert.equal(entryText(compact('c', 'a')), '');
  assert.equal(entryText(msg('tool', 'raw stdout', 'toolResult')), 'raw stdout');
});

test('grep supports case-insensitive regex OR and literal invalid regex fallback', async () => {
  const h = harness([msg('a', 'SF and san francisco and [literal'), msg('b', 'live SF'), compact('c', 'b')]);
  assert.equal((await h.run('history_grep', { pattern: 'sf|San Francisco' })).details.total, 2);
  assert.equal((await h.run('history_grep', { pattern: '[literal' })).details.total, 1);
  assert.match(text(await h.run('history_grep', { pattern: 'absent' })), /^No matches/);
  assert.doesNotMatch(text(await h.run('history_grep', { pattern: 'SF' })), /\[b\]/);
});

test('grep limits per-entry and global snippets while counting all matches', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => msg(String(i), Array.from({ length: 4 }, () => `hit${'x'.repeat(400)}`).join('')));
  const h = harness([...entries, msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'hit' });
  assert.equal(result.details.total, 48);
  assert.equal(text(result).split('\n').length, 31);
  assert.equal(result.details.snippets, 30);
  assert.equal(result.details.omitted, 18);
  assert.equal(text(result).split('\n').filter(l => l.startsWith('[0]')).length, 3);
  const empty = harness([msg('a', 'ab'), msg('b', 'tail'), compact('c', 'b')]);
  const zeroWidth = await empty.run('history_grep', { pattern: '' });
  assert.equal(zeroWidth.details.total, 3);
  assert.equal(zeroWidth.details.snippets, 1);
  assert.equal(zeroWidth.details.covered, 2);
});
test('grep pages matching entries so early matches and dense entries cannot hide later sources', async () => {
  const entries = [
    ...Array.from({ length: 40 }, (_, i) => msg(`early-${i}`, `signal unrelated ${i}`)),
    msg('event-a', 'signal community event alpha'),
    msg('event-b', 'signal community event beta'),
    msg('event-c', 'signal community event gamma'),
    msg('event-d', 'signal community event delta'),
  ];
  const h = harness([...entries, msg('live', 'tail'), compact('c', 'live')]);
  const first = await h.run('history_grep', { pattern: 'signal', limit: 30 });
  assert.equal(first.details.total, 44);
  assert.equal(first.details.totalEntries, 44);
  assert.equal(first.details.returned, 30);
  let offset = first.details.nextOffset;
  const ids = [...text(first).matchAll(/^\[([^\]]+)\]/gm)].map(match => match[1]);
  while (offset !== null) {
    const page = await h.run('history_grep', { pattern: 'signal', limit: 30, offset });
    ids.push(...[...text(page).matchAll(/^\[([^\]]+)\]/gm)].map(match => match[1]));
    offset = page.details.nextOffset;
  }
  assert.equal(new Set(ids).size, 44);
  assert.deepEqual(ids.slice(-4), ['event-a', 'event-b', 'event-c', 'event-d']);
  const dense = harness([msg('dense', 'hit '.repeat(20)), msg('later', 'hit later'), msg('live', 'tail'), compact('c', 'live')]);
  const page = await dense.run('history_grep', { pattern: 'hit', limit: 2 });
  assert.equal(page.details.total, 21);
  assert.equal(page.details.totalEntries, 2);
  assert.match(text(page), /\[later\]/);
});
test('grep omitted counts are response-global on first, continuation, final and empty pages', async () => {
  const h = harness([
    ...Array.from({ length: 80 }, (_, i) => msg(`signal-${i}`, 'signal')),
    msg('live', 'tail'), compact('c', 'live'),
  ]);
  const pages = [];
  pages.push(await h.run('history_grep', { pattern: 'signal' }));
  pages.push(await h.run('history_grep', { pattern: 'signal', offset: pages[0].details.nextOffset }));
  pages.push(await h.run('history_grep', { pattern: 'signal', offset: pages[1].details.nextOffset }));
  pages.push(await h.run('history_grep', { pattern: 'signal', offset: 80 }));
  for (const page of pages) {
    assert.equal(page.details.omitted, page.details.total - page.details.snippets - page.details.covered);
    assert.match(text(page), new RegExp(`raw matches not shown anywhere in this response: ${page.details.omitted}`));
  }
  assert.deepEqual(pages.map(page => [page.details.offset, page.details.returned, page.details.omitted]), [
    [0, 30, 50], [30, 30, 50], [60, 20, 60], [80, 0, 80],
  ]);
});

test('grep only reports oversized metadata when its entry is consumed', async () => {
  const entries = Array.from({ length: 45 }, (_, i) => msg(i === 30 ? 'x'.repeat(200) : `entry-${i}`, 'signal'));
  const h = harness([...entries, msg('live', 'tail'), compact('c', 'live')]);
  const first = await h.run('history_grep', { pattern: 'signal', limit: 50 });
  assert.equal(first.details.returned, 30);
  assert.equal(first.details.nextOffset, 30);
  assert.equal(first.details.metadataSkipped, false);
  assert.equal(first.details.omitted, 15);
  assert.doesNotMatch(text(first), /oversized metadata/);
  const next = await h.run('history_grep', { pattern: 'signal', limit: 50, offset: first.details.nextOffset });
  assert.equal(next.details.returned, 15);
  assert.equal(next.details.nextOffset, null);
  assert.equal(next.details.offset, 30);
  assert.equal(next.details.omitted, 31);
  assert.match(text(next), /oversized metadata/);
  assert.doesNotMatch(text(next), /\[x{20}/);
  assert.doesNotMatch(text(next), /x{200}/);
  assert.match(text(next), /\[entry-31\]/);
});

test('grep occurrence coverage distinguishes UTF-16 matches mapped to the same codepoint', async () => {
  const dot = harness([msg('two-emoji', '😀😀'), msg('live', 'tail'), compact('c', 'live')]);
  const all = await dot.run('history_grep', { pattern: '.' });
  assert.equal(all.details.total, 4);
  assert.equal(all.details.snippets, 1);
  assert.equal(all.details.covered, 3);
  assert.equal(all.details.omitted, 0);

  const empty = harness([msg('one-emoji', '😀'), msg('live', 'tail'), compact('c', 'live')]);
  const boundaries = await empty.run('history_grep', { pattern: '' });
  assert.equal(boundaries.details.total, 3);
  assert.equal(boundaries.details.snippets, 1);
  assert.equal(boundaries.details.covered, 2);
  assert.equal(boundaries.details.omitted, 0);

  const pages = harness([msg('first-emoji', '😀'), msg('second-emoji', '😀'), msg('live', 'tail'), compact('c', 'live')]);
  const first = await pages.run('history_grep', { pattern: '.', limit: 1 });
  const second = await pages.run('history_grep', { pattern: '.', limit: 1, offset: first.details.nextOffset });
  assert.deepEqual([first.details.total, first.details.snippets, first.details.covered, first.details.omitted], [4, 1, 1, 2]);
  assert.deepEqual([second.details.total, second.details.snippets, second.details.covered, second.details.omitted], [4, 1, 1, 2]);
});

test('grep final output stays within budget at the maximum line and metadata prefix', async () => {
  const entries = Array.from({ length: 30 }, (_, i) => msg(`${i.toString().padStart(2, '0')}${'m'.repeat(118)}`, 'z'.repeat(1000)));
  const h = harness([...entries, msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'z+' });
  assert.equal(result.details.snippets, 30);
  assert.ok([...text(result)].length <= 16000);
  for (const entry of entries) {
    const prefix = `[${entry.id}] ${stamp.slice(0, 10)} user: `;
    assert.equal([...prefix].length, 140);
    const line = text(result).split('\n').find(row => row.startsWith(prefix));
    assert.ok(line);
    assert.equal([...line].length, 498);
  }
});


test('grep page offsets, zero-width matches, invalid regex fallback and Unicode remain deterministic under snippet caps', async () => {
  const h = harness([
    msg('emoji', '😀literal [broken'),
    ...Array.from({ length: 40 }, (_, i) => msg(`budget-${i}`, `needle${'x'.repeat(1200)}END`)),
    msg('live', 'tail'), compact('c', 'live'),
  ]);
  const literal = await h.run('history_grep', { pattern: '[broken', limit: 1 });
  assert.equal(literal.details.returned, 1);
  assert.ok([...text(literal)].length <= 16000);
  const beyond = await h.run('history_grep', { pattern: 'needle', offset: 99 });
  assert.equal(beyond.details.returned, 0);
  assert.equal(beyond.details.nextOffset, null);
  const empty = await h.run('history_grep', { pattern: '', limit: 1 });
  assert.equal(empty.details.returned, 1);
  assert.ok(empty.details.total > 1);
  const first = await h.run('history_grep', { pattern: 'needle[\\s\\S]*END', limit: 40 });
  assert.equal(first.details.returned, 30);
  assert.equal(first.details.nextOffset, 30);
  assert.equal(first.details.hasMore, true);
  assert.match(text(first), /\[page offset=0 returned=30 .*nextOffset=30 hasMore=true\]/);
  const second = await h.run('history_grep', { pattern: 'needle[\\s\\S]*END', limit: 40, offset: first.details.nextOffset });
  assert.equal(second.details.returned, 10);
  assert.equal(second.details.nextOffset, null);
  assert.ok([...text(first)].length <= 16000);
});
test('grep does not count normalized whitespace as visible source coverage', async () => {
  for (const [body, pattern, total] of [
    ['A   B', '\\s', 3],
    ['A\nB\nC', '\n', 2],
    ['A\tB\tC', '\\t', 2],
    ['A   B X A   B', 'A\\s+B', 2],
  ]) {
    const h = harness([msg('normalized', body), msg('live', 'tail'), compact('c', 'live')]);
    const result = await h.run('history_grep', { pattern });
    assert.equal(result.details.total, total);
    assert.equal(result.details.snippets, total);
    assert.equal(result.details.covered, 0);
  }
});
test('grep does not cover zero-width boundaries adjacent to normalized whitespace', async () => {
  const h = harness([msg('boundaries', 'A\tB'), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: '' });
  assert.equal(result.details.total, 4);
  assert.equal(result.details.snippets, 3);
  assert.equal(result.details.covered, 1);
  assert.equal(result.details.omitted, 0);
});

test('grep clipped tail coverage excludes normalized whitespace', async () => {
  const h = harness([msg('clipped-tail', `BEGIN${'x'.repeat(1000)}END\t \tZ`), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'BEGIN[\\s\\S]*?END|\\s' });
  assert.equal(result.details.total, 4);
  assert.equal(result.details.snippets, 3);
  assert.equal(result.details.covered, 0);
  assert.equal(result.details.omitted, 1);
  assert.match(text(result), /snippet clipped/);
});
test('grep spends snippet slots on later text beyond already visible context', async () => {
  const h = harness([msg('coverage', `hit near hit near hit${'x'.repeat(400)}DISTANT hit`), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'hit' });
  assert.equal(result.details.total, 4);
  assert.match(text(result), /4 matches in 1 entries; 1 entries consumed, 2 representative snippets shown\. Matches covered by this page's snippets: 2/);
  assert.match(text(result), /DISTANT/);
});
test('grep coverage is entry-local and does not cover a partly visible match', async () => {
  const equalText = harness([msg('first', 'needle'), msg('second', 'needle'), msg('live', 'tail'), compact('c', 'live')]);
  const separate = await equalText.run('history_grep', { pattern: 'needle' });
  assert.equal(separate.details.total, 2);
  assert.equal(separate.details.snippets, 2);
  assert.equal(separate.details.covered, 0);
  const partialText = `${'x'.repeat(200)}A${'x'.repeat(149)}${'B'.repeat(20)}`;
  const partial = harness([msg('partial', partialText), msg('live', 'tail'), compact('c', 'live')]);
  const partlyCovered = await partial.run('history_grep', { pattern: 'A|B{20}' });
  assert.equal(partlyCovered.details.total, 2);
  assert.equal(partlyCovered.details.snippets, 2);
  assert.equal(partlyCovered.details.covered, 0);
});
test('grep bounds long matches and preserves useful clipped Unicode context', async () => {
  const h = harness([msg('long-match', `start😀${'x'.repeat(120000)}end😀`), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'start[\\s\\S]*end😀' });
  assert.equal(result.details.total, 1);
  assert.ok([...text(result)].length <= 16000);
  assert.match(text(result), /\[long-match\]/);
  assert.match(text(result), /snippet clipped/);
  assert.match(text(result), /start😀/);
  assert.match(text(result), /end😀/);
  assert.match(text(result), /history_expand/);
});

test('grep budgets multiple large snippets and reports omitted matches', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => msg(`large-${i}`, Array.from({ length: 4 }, () => `NEEDLE${'x'.repeat(3000)}END`).join(' ')));
  const h = harness([...entries, msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'NEEDLE[\\s\\S]*?END' });
  assert.equal(result.details.total, 48);
  assert.match(text(result), /48 matches in 12 entries; 12 entries consumed, 30 representative snippets shown/);
  assert.match(text(result), /raw matches not shown anywhere in this response: 18/);
  assert.ok([...text(result)].length <= 16000);
  assert.match(text(result), /snippet clipped/);
  assert.match(text(result), /history_expand/);
});

test('grep bounds extreme metadata without emitting partial ids and honors latest edits', async () => {
  const edited = msg('edited', 'originalSecret');
  const omitted = msg('omitted', 'omittedSecret');
  const enormousId = msg('id'.repeat(12000), 'visibleNeedle');
  const h = harness([edited, omitted, enormousId, msg('last', 'visibleNeedle'), msg('live', 'tail'), compact('c', 'live'),
    { type: 'context_edit', id: 'edit', timestamp: stamp, parentId: null, targetId: 'edited', replacement: { content: 'visibleNeedle' } },
    { type: 'context_edit', id: 'omit', timestamp: stamp, parentId: null, targetId: 'omitted', replacement: null }]);
  const result = await h.run('history_grep', { pattern: 'Needle|Secret' });
  assert.equal(result.details.total, 3);
  assert.equal(result.details.totalEntries, 3);
  assert.equal(result.details.returned, 3);
  assert.equal(result.details.nextOffset, null);
  assert.equal(result.details.metadataSkipped, true);
  assert.equal(result.details.omitted, 1);
  assert.ok([...text(result)].length <= 16000);
  assert.match(text(result), /\[edited\]/);
  assert.match(text(result), /\[last\]/);
  assert.doesNotMatch(text(result), /originalSecret|omittedSecret|\[id{20}/);
  assert.match(text(result), /oversized metadata/);
});

test('grep keeps normal short result snippets and complete match counts', async () => {
  const h = harness([msg('short', 'before needle after'), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'needle' });
  assert.equal(result.details.total, 1);
  assert.match(text(result), /before needle after/);
  assert.doesNotMatch(text(result), /snippet clipped/);
});
test('grep retains the normal context window when a short match fits', async () => {
  const body = `LEFT_EVIDENCE${'a'.repeat(100)}needle${'b'.repeat(100)}RIGHT_EVIDENCE`;
  const h = harness([msg('context', body), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: 'needle' });
  assert.match(text(result), /LEFT_EVIDENCE/);
  assert.match(text(result), /RIGHT_EVIDENCE/);
});
test('grep maps UTF-16 regex matches onto whole Unicode codepoints', async () => {
  const h = harness([msg('emoji', '😀'), msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_grep', { pattern: '.' });
  assert.equal(result.details.total, 2);
  assert.equal(result.details.snippets, 1);
  assert.equal(result.details.covered, 1);
  assert.equal(result.details.omitted, 0);
  assert.match(text(result), /😀/);
  assert.doesNotMatch(text(result), /�/);
});

test('calls use the current branch each time, excluding alternate and live entries', async () => {
  const h = harness([msg('a', 'branch alpha'), msg('live', 'tail'), compact('c', 'live')]);
  assert.equal((await h.run('history_grep', { pattern: 'alpha' })).details.total, 1);
  h.setBranch([msg('b', 'branch beta'), msg('live', 'alpha'), compact('c2', 'live')]);
  assert.equal((await h.run('history_grep', { pattern: 'alpha' })).details.total, 0);
  assert.match(text(await h.run('history_expand', { id: 'a' })), /No compacted entry/);
  assert.match(text(await h.run('history_expand', { id: 'live' })), /No compacted entry/);
  h.setBranch([msg('fresh', 'beta')]);
  assert.equal((await h.run('history_grep', { pattern: 'beta' })).details.total, 0);
});

test('expand honors neighbors, zero bounds and raw tool text', async () => {
  const h = harness([msg('a', 'before'), msg('b', 'stdout', 'toolResult'), msg('d', 'after'),
  msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_expand', { id: 'b' });
  assert.deepEqual([result.details.from, result.details.to], ['a', 'd']);
  assert.match(text(result), /toolResult \(requested\)\nstdout/);
  const alone = await h.run('history_expand', { id: 'b', before: 0, after: 0 });
  assert.deepEqual([alone.details.from, alone.details.to], ['b', 'b']);
  assert.doesNotMatch(text(alone), /before|after|tail/);
});

test('expand keeps the target visible and pages long Unicode text without gaps', async () => {
  const target = `start${'😀x'.repeat(9000)}end`;
  const input = [msg('huge-before', 'z'.repeat(MAX_EXPAND_CHARS * 2)), msg('target', target),
  msg('live', 'tail'), compact('c', 'live')];
  const snapshot = structuredClone(input);
  const h = harness(input);
  const first = await h.run('history_expand', { id: 'target', before: 1, after: 0 });
  assert.match(text(first), /\[target\].*\(requested\)/);
  assert.match(text(first), /start/);
  assert.equal(first.details.offset, 0);
  assert.equal(first.details.hasMore, true);
  assert.equal(first.details.nextOffset, first.details.returned);
  assert.equal(first.details.total, [...target].length);
  assert.ok(Array.from(text(first)).length <= MAX_EXPAND_CHARS);
  assert.deepEqual([first.details.from, first.details.to], ['target', 'target']);
  assert.match(text(first), /\[page offset=0 returned=\d+ total=\d+ nextOffset=\d+ hasMore=true\]$/);
  assert.deepEqual(input, snapshot);

  const pages = [first];
  while (pages.at(-1).details.hasMore) {
    const previous = pages.at(-1).details;
    pages.push(await h.run('history_expand', { id: 'target', before: 1, after: 0, offset: previous.nextOffset }));
  }
  assert.ok(pages.every((page) => {
    const output = text(page);
    const body = output.replace(/\n\[page offset=.*\]$/, '').slice(output.indexOf('\n') + 1);
    const { offset, returned, total, nextOffset, hasMore } = page.details;
    assert.match(output, new RegExp(`\\[page offset=${offset} returned=${returned} total=${total} nextOffset=${nextOffset} hasMore=${hasMore}\\]$`));
    assert.doesNotMatch(body, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    return offset + returned === nextOffset;
  }));
  assert.equal(pages.at(-1).details.hasMore, false);
  assert.equal(pages.at(-1).details.nextOffset, [...target].length);
  const joined = pages.map((page) => text(page).replace(/\n\[page offset=.*\]$/, '').slice(text(page).indexOf('\n') + 1)).join('');
  assert.equal(joined, target);
  assert.match(text(pages.at(-1)), /end/);
  assert.doesNotMatch(text(first), /huge-before/);
  assert.deepEqual(input, snapshot);
});

test('expand reports only complete neighbors and handles empty/out-of-range pages', async () => {
  const h = harness([msg('before', 'context before'), msg('target', 'short'), msg('after', 'context after'),
  msg('live', 'tail'), compact('c', 'live')]);
  const result = await h.run('history_expand', { id: 'target' });
  assert.match(text(result), /context before/);
  assert.match(text(result), /context after/);
  assert.deepEqual([result.details.from, result.details.to], ['before', 'after']);
  assert.equal(result.details.total, 5);
  assert.equal(result.details.returned, 5);
  assert.equal(result.details.hasMore, false);
  const empty = await h.run('history_expand', { id: 'target', offset: 0, before: 0, after: 0 });
  assert.equal(empty.details.nextOffset, 5);
  const beyond = await h.run('history_expand', { id: 'target', offset: 99, before: 0, after: 0 });
  assert.equal(beyond.details.offset, 5);
  assert.equal(beyond.details.returned, 0);
  assert.equal(beyond.details.hasMore, false);
  assert.equal(beyond.details.nextOffset, 5);
  assert.match(text(await h.run('history_expand', { id: 'missing' })), /No compacted entry/);
});



test('English literal concepts share automatic candidates and order with independent pagination', async () => {
  const entries = [msg('old', 'quasar old'), msg('best', 'quasar nebula'), msg('recent', 'quasar recent'),
  msg('tool', 'quasar nebula', 'toolResult'), msg('live', 'quasar nebula live'), compact('c', 'live')];
  const h = harness(entries);
  const result = text(await h.run('history_recall', { concepts: [['quasar'], ['nebula']] }));
  const resultRows = result.trim().split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  const autoRows = (await h.auto('quasar nebula')).split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.deepEqual(resultRows, autoRows);
  assert.ok(Array.from(result).length <= RECALL_PAGE_CHARS);
  assert.deepEqual(resultRows.map(row => row.id), ['best', 'recent', 'old']);
  h.setBranch([msg('alternate', 'quasar'), msg('live', 'tail'), compact('c2', 'live')]);
  const alternate = text(await h.run('history_recall', { concepts: [['quasar']] }));
  assert.match(alternate, /alternate/);
  assert.doesNotMatch(alternate, /"id":"best"/);
});

test('manual recall permits rewritten keywords but does not invent semantic synonym matches', async () => {
  const h = harness([msg('bike', 'bicycle repair appointment'), msg('live', 'tail'), compact('c', 'live')]);
  const missing = await h.run('history_recall', { concepts: [['cycling']] });
  assert.equal(missing.details.total, 0);
  assert.match(text(await h.run('history_recall', { concepts: [['bicycle repair']] })), /"id":"bike"/);
  for (const surface of ['the and', 'unmatched']) {
    assert.equal((await h.run('history_recall', { concepts: [[surface]] })).details.total, 0);
  }
  await assert.rejects(h.run('history_recall', { concepts: [['']] }), { name: 'QueryError', code: 'EMPTY_TEXT' });
  h.setBranch([msg('uncompacted', 'bicycle repair')]);
  assert.equal((await h.run('history_recall', { concepts: [['bicycle']] })).details.total, 0);
});

test('all search remains null-safe and excludes tool results while expansion can read them', async () => {
  const malformed = msg('broken', 'unused');
  malformed.message.content = [null, undefined, { type: 'text', text: 'quasar valid' }];
  const h = harness([malformed, msg('stdout', 'needle only in tool output', 'toolResult'), msg('live', 'tail'), compact('c', 'live')]);
  assert.match(text(await h.run('history_recall', { concepts: [['quasar']] })), /"id":"broken"/);
  assert.equal((await h.run('history_recall', { concepts: [['needle']] })).details.total, 0);
  assert.equal((await h.run('history_grep', { pattern: 'needle' })).details.total, 0);
  assert.match(text(await h.run('history_expand', { id: 'stdout', before: 0, after: 0 })), /needle only in tool output/);
});
