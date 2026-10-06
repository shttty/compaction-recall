import '../../fixtures/isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import register from '../../../src/index.ts';
import * as history from '../../../src/history/history.mjs';
import { LOCATOR_TYPE } from '../../../src/history/locator.mjs';

const shutdowns = [];
afterEach(async () => { for (const shutdown of shutdowns.splice(0)) await shutdown(); });
const stamp = '2026-10-02T00:00:00.000Z';
const message = (content, role = 'user') => ({ role, content, timestamp: 1 });
const msg = (id, content, role = 'user') => ({ type: 'message', id, parentId: null, timestamp: stamp, message: message(content, role) });
const edit = (id, targetId, content) => ({
  type: 'context_edit', id, parentId: null, timestamp: stamp,
  targetId, replacement: content === null ? null : { content }
});
const comp = (firstKeptEntryId = 'live', id = 'compaction') => ({
  type: 'compaction', id, parentId: null,
  timestamp: stamp, firstKeptEntryId, summary: 'summaryOnlyMarker', tokensBefore: 100
});
const rows = text => text?.split('\n').filter(line => line.startsWith('{')).map(JSON.parse) ?? [];
const text = result => result.content[0].text;
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function host(sessionManager) {
  const tools = new Map(), hooks = new Map();
  register({ registerTool: tool => tools.set(tool.name, tool), on: (name, hook) => hooks.set(name, hook) });
  shutdowns.push(() => hooks.get('session_shutdown')());
  const ctx = { sessionManager };
  return {
    run: (name, params) => tools.get(name).execute('context-edit', params, undefined, undefined, ctx),
    async auto(query) {
      const result = await hooks.get('context')({ messages: [message(query)] }, ctx);
      return result.messages.find(m => m.customType === LOCATOR_TYPE)?.content;
    },
  };
}
async function absent(h, query) {
  assert.ok(rows(await h.auto(query)).every(row => !row.snippet.includes(query)), `automatic locator leaked ${query}`);
  assert.equal((await h.run('history_recall', { concepts: [[query]] })).details.total, 0, `recall leaked ${query}`);
  assert.equal((await h.run('history_grep', { pattern: query })).details.total, 0, `grep leaked ${query}`);
}
async function found(h, query, id) {
  const automatic = await h.auto(query);
  assert.ok(rows(automatic).some(row => row.id === id)); // Automatic OR can return other records sharing identifier components.
  assert.ok(automatic.includes(query));
  const recalled = await h.run('history_recall', { concepts: [[query]] });
  assert.equal(recalled.details.total, 1);
  assert.deepEqual(rows(text(recalled)).map(row => row.id), [id]);
  assert.ok(text(recalled).includes(query));
  const grepped = await h.run('history_grep', { pattern: query });
  assert.equal(grepped.details.total, 1);
  assert.ok(text(grepped).includes(`[${id}]`));
  assert.ok(text(grepped).includes(query));
}

test('branch projection applies last edits, normalizes raw string replacements and never mutates frozen source', () => {
  const blocks = [{ type: 'text', text: 'blockReplacement' }];
  const raw = freeze([
    msg('user', 'oldUser'), msg('assistant', [{ type: 'text', text: 'oldAssistant' }], 'assistant'),
    msg('tool', [{ type: 'text', text: 'oldTool' }], 'toolResult'), msg('block', 'oldBlock'),
    msg('omitted', 'oldOmitted'), msg('untouched', 'stillOriginal'),
    edit('omit-user', 'user', null), edit('replace-user', 'user', 'newUser'),
    edit('replace-assistant', 'assistant', 'newAssistant'), edit('replace-tool', 'tool', 'newTool'),
    edit('replace-block', 'block', blocks), edit('replace-omitted', 'omitted', 'temporary'),
    edit('omit-last', 'omitted', null),
  ]);
  const snapshot = JSON.stringify(raw);
  const projected = history.branchMessageEntries(raw);
  assert.deepEqual(projected.map(e => e.id), ['user', 'assistant', 'tool', 'block', 'untouched']);
  assert.deepEqual(projected.map(e => e.message.content), [
    'newUser', [{ type: 'text', text: 'newAssistant' }], [{ type: 'text', text: 'newTool' }], blocks, 'stillOriginal',
  ]);
  assert.equal(projected[4], raw[5]);
  for (let i = 0; i < 4; i++) {
    assert.notEqual(projected[i], raw[i]);
    assert.notEqual(projected[i].message, raw[i].message);
    assert.equal(projected[i].timestamp, raw[i].timestamp);
    assert.equal(projected[i].message.role, raw[i].message.role);
  }
  // end limits raw message positions, not the edits consulted or projected row count.
  assert.deepEqual(history.branchMessageEntries(raw, 2).map(e => history.entryText(e)), ['newUser', 'newAssistant']);
  assert.equal(JSON.stringify(raw), snapshot);
});

test('registered hook and tools honor replacements, omitted neighbours and tool-result search exclusion', async () => {
  const raw = freeze([
    msg('left', 'leftOriginal'), msg('gone', 'omittedSecret'),
    msg('target', [{ type: 'text', text: 'oldAnswer' }, { type: 'toolCall', id: 'call', name: 'oldLookup', arguments: { key: 'oldArgument' } }], 'assistant'),
    msg('result', [{ type: 'text', text: 'oldToolSecret' }], 'toolResult'), msg('right', 'rightOriginal'),
    edit('before-compaction', 'target', 'intermediateAnswer'),
    msg('live', 'retainedSecret'), comp(),
    edit('omit', 'gone', null), edit('answer', 'target', [{ type: 'text', text: 'replacementAnswer' }]),
    edit('result-edit', 'result', 'replacementToolSecret'),
  ]);
  const snapshot = JSON.stringify(raw), h = host({ getBranch: () => raw });
  await found(h, 'replacementAnswer', 'target');
  for (const query of ['omittedSecret', 'oldAnswer', 'oldLookup', 'oldArgument', 'intermediateAnswer', 'oldToolSecret', 'replacementToolSecret', 'retainedSecret', 'summaryOnlyMarker']) await absent(h, query);
  const expanded = await h.run('history_expand', { id: 'target', before: 1, after: 2 });
  assert.deepEqual([expanded.details.from, expanded.details.to], ['left', 'right']);
  for (const content of ['leftOriginal', 'replacementAnswer', 'replacementToolSecret', 'rightOriginal']) assert.ok(text(expanded).includes(content));
  assert.doesNotMatch(text(expanded), /omittedSecret|oldAnswer|oldLookup|oldArgument|oldToolSecret|retainedSecret/);
  assert.match(text(await h.run('history_expand', { id: 'result', before: 0, after: 0 })), /replacementToolSecret/);
  assert.equal(text(await h.run('history_expand', { id: 'gone' })), 'No compacted entry with id gone.');
  assert.equal(text(await h.run('history_expand', { id: 'live' })), 'No compacted entry with id live.');
  assert.equal(JSON.stringify(raw), snapshot);
});

test('raw compaction boundary survives omitted first-kept entries and edits on both sides', async () => {
  const raw = freeze([
    msg('old', 'oldBoundaryValue'), edit('early', 'old', 'beforeCompactionValue'),
    msg('live', 'retainedBoundaryValue'), msg('retained', 'retainedTailValue'), comp(),
    edit('omit-boundary', 'live', null), edit('late', 'old', 'afterCompactionValue'),
  ]);
  assert.deepEqual(history.compactedEntries(raw).map(e => [e.id, history.entryText(e)]), [['old', 'afterCompactionValue']]);
  assert.deepEqual(history.compactedEntries(raw.slice(0, 5)).map(e => [e.id, history.entryText(e)]), [['old', 'beforeCompactionValue']]);
  const h = host({ getBranch: () => raw });
  await found(h, 'afterCompactionValue', 'old');
  for (const query of ['oldBoundaryValue', 'beforeCompactionValue', 'retainedBoundaryValue', 'retainedTailValue']) await absent(h, query);
  assert.equal(text(await h.run('history_expand', { id: 'retained' })), 'No compacted entry with id retained.');
  // A subsequent compaction deliberately moves the raw boundary beyond the retained tail.
  const later = [...raw, msg('new-live', 'newRetainedValue'), comp('new-live', 'second-compaction')];
  assert.deepEqual(history.compactedEntries(later).map(e => [e.id, history.entryText(e)]), [
    ['old', 'afterCompactionValue'], ['retained', 'retainedTailValue'],
  ]);
});

test('missing boundary falls back to raw compaction position; uncompressed history remains unavailable', async () => {
  const raw = freeze([
    msg('old', 'oldFallbackValue'), msg('gone', 'goneFallbackValue'), comp('missing'),
    msg('after', 'afterCompactionTail'), edit('replacement', 'old', 'newFallbackValue'), edit('omit', 'gone', null),
  ]);
  assert.deepEqual(history.compactedEntries(raw).map(e => [e.id, history.entryText(e)]), [['old', 'newFallbackValue']]);
  const h = host({ getBranch: () => raw });
  await found(h, 'newFallbackValue', 'old');
  for (const query of ['oldFallbackValue', 'goneFallbackValue', 'afterCompactionTail']) await absent(h, query);
  assert.match(text(await h.run('history_expand', { id: 'old', before: 0, after: 0 })), /newFallbackValue/);
  const uncompressed = raw.filter(e => e.type !== 'compaction');
  assert.deepEqual(history.compactedEntries(uncompressed), []);
  const noCompaction = host({ getBranch: () => uncompressed });
  await absent(noCompaction, 'newFallbackValue');
  assert.equal(text(await noCompaction.run('history_expand', { id: 'old' })), 'No compacted entry with id old.');
});

test('SDK normalizes edits offline and branching restores originals across all registered entrypoints', async () => {
  const manager = SessionManager.inMemory();
  const userId = manager.appendMessage(message('originalUserMarker'));
  const assistantId = manager.appendMessage(message([{ type: 'text', text: 'originalAssistantMarker' }], 'assistant'));
  const toolId = manager.appendMessage({ ...message([{ type: 'text', text: 'originalToolMarker' }], 'toolResult'), toolCallId: 'lookup', toolName: 'lookup', isError: false });
  const originalLeaf = toolId;
  const userEdit = manager.appendContextEdit(userId, { content: 'editedUserMarker' });
  const assistantEdit = manager.appendContextEdit(assistantId, { content: 'editedAssistantMarker' });
  const toolEdit = manager.appendContextEdit(toolId, { content: 'editedToolMarker' });
  const entries = manager.getBranch();
  assert.equal(entries.find(e => e.id === userEdit).replacement.content, 'editedUserMarker');
  assert.deepEqual(entries.find(e => e.id === assistantEdit).replacement.content, [{ type: 'text', text: 'editedAssistantMarker' }]);
  assert.deepEqual(entries.find(e => e.id === toolEdit).replacement.content, [{ type: 'text', text: 'editedToolMarker' }]);
  // Validate SDK model projection only before compaction: it intentionally drops compacted messages.
  assert.deepEqual(manager.buildSessionContext().messages.map(m => m.content), [
    'editedUserMarker', [{ type: 'text', text: 'editedAssistantMarker' }], [{ type: 'text', text: 'editedToolMarker' }],
  ]);
  manager.appendContextEdit(userId, null);
  assert.deepEqual(manager.buildSessionContext().messages.map(m => m.role), ['assistant', 'toolResult']);
  manager.appendContextEdit(userId, { content: [{ type: 'text', text: 'finalUserMarker' }] });
  const live = manager.appendMessage(message('currentTailMarker'));
  const beforeLateEdits = manager.appendCompaction('summaryOnlyMarker', live, 100);
  const source = manager.getBranch().filter(e => e.type === 'message');
  const snapshot = JSON.stringify(source);
  source.forEach(freeze);
  const h = host(manager);
  await found(h, 'finalUserMarker', userId);
  await found(h, 'editedAssistantMarker', assistantId);
  await absent(h, 'editedToolMarker');
  const longReplacement = `editedAssistantMarker:${'😀x'.repeat(9000)}:replacementTail`;
  manager.appendContextEdit(assistantId, { content: longReplacement });
  const pages = [];
  let page = await h.run('history_expand', { id: assistantId, before: 0, after: 0 });
  while (true) {
    const output = text(page);
    const body = output.replace(/\n\[page offset=.*\]$/, '').slice(output.indexOf('\n') + 1);
    const { offset, returned, total, nextOffset, hasMore } = page.details;
    assert.equal(total, [...longReplacement].length);
    assert.equal(nextOffset, offset + returned);
    assert.match(output, new RegExp(`\\[page offset=${offset} returned=${returned} total=${total} nextOffset=${nextOffset} hasMore=${hasMore}\\]$`));
    assert.doesNotMatch(body, /originalAssistantMarker/);
    pages.push(body);
    if (!hasMore) break;
    page = await h.run('history_expand', { id: assistantId, before: 0, after: 0, offset: nextOffset });
  }
  assert.ok(pages.length > 1);
  assert.equal(pages.join(''), longReplacement);
  manager.appendContextEdit(assistantId, null);
  const toolWithNeighbours = text(await h.run('history_expand', { id: toolId, before: 1, after: 0 }));
  assert.match(toolWithNeighbours, /editedToolMarker/);
  assert.doesNotMatch(toolWithNeighbours, /originalAssistantMarker|editedAssistantMarker/);
  assert.match(text(await h.run('history_expand', { id: toolId, before: 0, after: 0 })), /editedToolMarker/);
  await absent(h, 'editedAssistantMarker');
  assert.equal(text(await h.run('history_expand', { id: assistantId })), `No compacted entry with id ${assistantId}.`);
  manager.appendContextEdit(assistantId, { content: 'restoredAssistantMarker' });
  const editedLeaf = manager.getBranch().at(-1).id;
  await found(h, 'restoredAssistantMarker', assistantId);
  manager.branch(beforeLateEdits);
  await found(h, 'editedAssistantMarker', assistantId);
  await absent(h, 'restoredAssistantMarker');
  manager.branch(originalLeaf);
  assert.deepEqual(manager.buildSessionContext().messages.map(m => m.content), [
    'originalUserMarker', [{ type: 'text', text: 'originalAssistantMarker' }], [{ type: 'text', text: 'originalToolMarker' }],
  ]);
  const otherLive = manager.appendMessage(message('otherBranchTail'));
  manager.appendCompaction('other summary', otherLive, 100);
  await found(h, 'originalUserMarker', userId);
  await found(h, 'originalAssistantMarker', assistantId);
  await absent(h, 'finalUserMarker');
  await absent(h, 'restoredAssistantMarker');
  assert.match(text(await h.run('history_expand', { id: toolId, before: 0, after: 0 })), /originalToolMarker/);
  manager.branch(editedLeaf);
  await found(h, 'restoredAssistantMarker', assistantId);
  await absent(h, 'originalAssistantMarker');
  assert.equal(JSON.stringify(source), snapshot);
});
