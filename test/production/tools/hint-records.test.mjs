import '../../fixtures/isolated-agent-dir.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import register from '../../../src/index.ts';
import { HINT_ENTRY_TYPE } from '../../../src/history/locator.mjs';

const user = (content, timestamp) => ({ role: 'user', content, timestamp });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 0 });
const records = manager => manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === HINT_ENTRY_TYPE);

function host(manager) {
  const hooks = new Map();
  register({
    registerTool() {}, appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    on: (name, hook) => hooks.set(name, hook),
  });
  const ctx = { sessionManager: manager };
  return {
    input: (text, source) => hooks.get('input')({ type: 'input', text, source }, ctx),
    context: async messages => (await hooks.get('context')({ type: 'context', messages: structuredClone(messages) }, ctx)).messages,
    close: () => hooks.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx),
  };
}

test('hints are recorded once per user message and replayed with identical bytes', async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user('dnf ansible-core 2.21.5 EL8 模块可用', 1));
  manager.appendMessage(assistant('ok'));
  const live = manager.appendMessage(user('retained tail', 2));
  manager.appendCompaction('summary', live, 100);
  const first = user('dnf ansible-core 怎么装', 3);
  manager.appendMessage(first);
  let h = host(manager);
  try {
    const turn = [user('retained tail', 2), first];
    const opened = await h.context(turn);
    const hint = opened[1].content.at(-1).text;
    assert.match(hint, /^<compacted-history-hints>/);
    assert.equal(opened[1].content[0].text, first.content); // The typed text stays first and unchanged.
    assert.equal(records(manager).length, 1);

    const toolLoop = await h.context([...turn, assistant('looking'), { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false, timestamp: 0 }]);
    assert.equal(records(manager).length, 1); // Same timestamp: no second lookup.
    assert.deepEqual(toolLoop[1], opened[1]);

    const next = user('好的', 4);
    manager.appendMessage(next);
    const later = await h.context([...turn, assistant('done'), next]);
    assert.deepEqual(later.slice(0, 2), opened); // The earlier prefix is byte-identical.
    assert.equal(later[3].content, next.content); // No match: no hint, recorded as null.
    assert.deepEqual(records(manager).map(entry => entry.data.content === null), [false, true]);

    await h.close();
    h = host(manager); // Resume: records come from the session, nothing is looked up again.
    assert.deepEqual(await h.context([...turn, assistant('done'), next]), later);
    assert.equal(records(manager).length, 2);
  } finally { await h.close(); }
});

test('records before the latest compaction are not replayed and extension input gets none', async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user('dnf ansible-core 2.21.5 EL8 模块可用', 1));
  const live = manager.appendMessage(user('retained tail', 2));
  manager.appendCompaction('summary', live, 100);
  const asked = user('dnf ansible-core 怎么装', 3);
  const askedId = manager.appendMessage(asked);
  const h = host(manager);
  try {
    assert.ok(Array.isArray((await h.context([asked]))[0].content));
    manager.appendCompaction('summary 2', askedId, 100);
    const peer = user('dnf ansible-core 结果', 5);
    manager.appendMessage(peer);
    await h.input(peer.content, 'extension');
    const replayed = await h.context([asked, peer]);
    assert.equal(replayed[0].content, asked.content); // Its record predates the compaction.
    assert.equal(replayed[1].content, peer.content);
    assert.equal(records(manager).at(-1).data.content, null);
  } finally { await h.close(); }
});
