import '../../fixtures/isolated-agent-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../../../src/index.ts';
import { LOCATOR_TYPE } from '../../../src/history/locator.mjs';

const timestamp = '2026-10-25T00:00:00Z';
const msg = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
const followup = '这个怎么可以呢';
const ids = text => text?.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).id).sort() ?? [];
const history = [
  msg('dnf', 'dnf ansible-core 2.21.5 EL8 Python 3.9 模块可用'),
  msg('docker', 'docker 容器网络故障已经修复'),
  msg('migration', '迁移方案完成后开始实验'),
  msg('fragment', '这是无关的移实记录'),
  ...Array.from({ length: 8 }, (_, i) => msg(`generic-${i}`, `插件上下文规则 ${i}`)),
];

function harness(jieba, records = history) {
  const saved = { mode: process.env.COMPACTION_RECALL_MODE, jieba: process.env.COMPACTION_RECALL_JIEBA };
  process.env.COMPACTION_RECALL_MODE = 'full';
  process.env.COMPACTION_RECALL_JIEBA = jieba ? 'on' : 'off';
  const tools = new Map(), hooks = new Map();
  try {
    register({ registerTool: tool => tools.set(tool.name, tool), on(name, fn) {
      const handlers = hooks.get(name) ?? []; handlers.push(fn); hooks.set(name, handlers);
    } });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      const name = `COMPACTION_RECALL_${key.toUpperCase()}`;
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  const branch = [...records, msg('live', 'retained'),
    { type: 'compaction', id: 'compact', timestamp, firstKeptEntryId: 'live', summary: '', tokensBefore: 100 }];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'automatic-topic-fixture' } };
  const emit = async (name, fields = {}) => {
    let result;
    for (const handler of hooks.get(name) ?? []) result = await handler({ type: name, ...fields }, ctx);
    return result;
  };
  return {
    async auto(texts) {
      const messages = texts.map(content => ({ role: 'user', content, timestamp: 0 }));
      // Assistant/tool text must not become a borrowed topic.
      messages.splice(messages.length - 1, 0, { role: 'assistant', content: [{ type: 'text', text: 'docker' }], timestamp: 0 });
      const result = await emit('context', { messages });
      const hint = result.messages.find(message => message.customType === LOCATOR_TYPE)?.content;
      return ids(hint);
    },
    async recall(surface) {
      const result = await tools.get('history_recall').execute('automatic-topic', { concepts: [[surface]] }, undefined, undefined, ctx);
      return ids(result.content[0].text);
    },
    close: () => emit('session_shutdown', { reason: 'quit' }),
  };
}

for (const jieba of [true, false]) {
  const label = jieba ? 'jieba' : 'Intl.Segmenter';
  test(`automatic topic borrows dnf when the current message contains only stopwords (${label})`, async () => {
    const host = harness(jieba);
    try {
      assert.deepEqual(await host.auto(['dnf ansible-core', followup]), ['dnf']);
      assert.deepEqual(await host.auto([followup]), []);
      assert.deepEqual(await host.auto(['dnf 这个 怎么']), ['dnf']);
    } finally { await host.close(); }
  });

  test(`current usable topic replaces earlier topics in both directions (${label})`, async () => {
    const host = harness(jieba);
    try {
      assert.deepEqual(await host.auto(['dnf ansible-core', 'docker 怎么']), ['docker']);
      assert.deepEqual(await host.auto(['docker 怎么', 'dnf ansible-core']), ['dnf']);
      assert.deepEqual(await host.auto(['dnf ansible-core', '插件 上下文']), ['generic-3', 'generic-4', 'generic-5', 'generic-6', 'generic-7']);
    } finally { await host.close(); }
  });

  test(`short followups borrow only the previous two user messages (${label})`, async () => {
    const host = harness(jieba);
    try {
      assert.deepEqual(await host.auto(['dnf ansible-core', followup]), ['dnf']);
      assert.deepEqual(await host.auto(['dnf ansible-core', followup, followup]), ['dnf']);
      assert.deepEqual(await host.auto([followup, followup]), []);
      assert.deepEqual(await host.auto(['dnf ansible-core', followup, '那这个呢', followup]), []);
      assert.deepEqual(await host.auto(['dnf ansible-core', 'docker 怎么', followup]), ['docker']);
    } finally { await host.close(); }
  });

  test(`Han word boundaries reject cross-word fragments (${label})`, async () => {
    const host = harness(jieba);
    try {
      assert.deepEqual(await host.auto(['迁移实验']), ['migration']);
    } finally { await host.close(); }
  });

  test(`automatic gate measures only the current message before borrowing (${label})`, async () => {
    const host = harness(jieba);
    try {
      assert.deepEqual(await host.auto(['dnf ansible-core' + ' '.repeat(400), followup + ' '.repeat(266)]), ['dnf']);
      assert.deepEqual(await host.auto(['dnf ansible-core', followup + ' '.repeat(267)]), []);
      assert.deepEqual(await host.auto(['dnf ansible-core', '']), []);
      assert.deepEqual(await host.auto([]), []);
    } finally { await host.close(); }
  });

  test(`automatic Han words match ordered complete phrases rather than scattered fragments (${label})`, async () => {
    const host = harness(jieba, [msg('context', '上下文'), msg('scattered', '上下 下文')]);
    try {
      assert.deepEqual(await host.auto(['上下文??']), ['context']);
    } finally { await host.close(); }
  });

  test(`adjacent unknown single Han segments merge, but punctuation never joins them (${label})`, async () => {
    const host = harness(jieba, [msg('name', '雪珞'), msg('apart', '雪，珞')]);
    try {
      assert.deepEqual(await host.auto(['雪珞?????']), ['name']);
      assert.deepEqual(await host.auto(['雪，珞??']), []);
    } finally { await host.close(); }
  });

  test(`stopwords alone never prompt automatically but remain indexed for manual recall (${label})`, async () => {
    const words = [['这个', 'deictic'], ['怎么', 'how'], ['为什么', 'why'], ['history', 'english']];
    const host = harness(jieba, words.map(([word, id]) => msg(id, word)));
    try {
      for (const [word, id] of words) {
        assert.deepEqual(await host.auto([word + '?????']), [], word);
        assert.deepEqual(await host.recall(word), [id], word);
      }
    } finally { await host.close(); }
  });

  test(`borrowing caps usable terms instead of widening to every previous entity (${label})`, async () => {
    const entities = ['quasar', 'nebula', 'orchard', 'harvest', 'saturn', 'jupiter'];
    const host = harness(jieba, entities.map(entity => msg(entity, entity)));
    try {
      assert.deepEqual(await host.auto([entities.join(' '), followup]), entities.slice(0, 4).sort());
    } finally { await host.close(); }
  });

  test(`current messages of at most ten trimmed UTF-8 bytes never recall or borrow (${label})`, async () => {
    const host = harness(jieba);
    try {
      for (const current of ['继续', '好的', 'ok', 'dnf!!!!!!!', '\u3000 dnf!!!!!!! \n', 'dnf😀甲']) {
        assert.deepEqual(await host.auto(['dnf ansible-core', current]), [], JSON.stringify(current));
      }
      assert.deepEqual(await host.auto(['dnf!!!!!!!!']), ['dnf']); // 11 ASCII bytes.
      assert.deepEqual(await host.auto(['dnf😀甲!']), ['dnf']); // 11 UTF-8 bytes, 6 code points.
      assert.deepEqual(await host.auto(['dnf ansible-core', '这个怎么']), ['dnf']); // 12 bytes.
    } finally { await host.close(); }
  });

  test(`borrowed topics must have eleven to 239 trimmed UTF-8 bytes (${label})`, async () => {
    const host = harness(jieba);
    const nearMaximum = 'dnf ' + '😀'.repeat(58) + '!!!'; // 239 UTF-8 bytes.
    try {
      for (const previous of ['dnf', 'dnf!!!!!!!', ' \tdnf!!!!!!!\n', nearMaximum + '!']) {
        assert.deepEqual(await host.auto([previous, followup]), [], JSON.stringify(previous));
      }
      for (const previous of ['dnf!!!!!!!!', nearMaximum, '\u3000 ' + nearMaximum + '\n']) {
        assert.deepEqual(await host.auto([previous, followup]), ['dnf']);
      }
    } finally { await host.close(); }
  });

  test(`ineligible previous messages consume the fixed two-user window without refill (${label})`, async () => {
    const host = harness(jieba);
    const tooLong = 'docker ' + '!'.repeat(233); // 240 bytes.
    try {
      assert.deepEqual(await host.auto(['dnf ansible-core', 'ok', followup]), ['dnf']);
      assert.deepEqual(await host.auto(['dnf ansible-core', tooLong, followup]), ['dnf']);
      assert.deepEqual(await host.auto(['dnf ansible-core', 'ok', tooLong, followup]), []);
    } finally { await host.close(); }
  });
}
