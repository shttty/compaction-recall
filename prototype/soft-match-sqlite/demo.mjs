import { createIndex, extractText, tokenize, weightedLength } from './index.mjs';

export const documents = [
  { id: 'a', text: '网关重启后断连，需要重新连接。' },
  { id: 'b', text: '网关配置保持不变。' },
  { id: 'c', text: '网，关之间有标点。' },
  { id: 'd', text: '搜索引擎使用内存索引。' },
  { id: 'e', text: '修改youer服务端配置。' },
  { id: 'f', text: 'CompactionResult is recorded.' },
  { id: 'g', text: 'vm is isolated.' },
  { id: 'h', text: 'kvm is enabled.' },
  { id: 'i', text: 'gateway restart disconnected' },
  { id: 'j', text: 'gateway configuration' },
  { id: 'k', text: 'I stop checking work emails after dinner.' },
  { id: 'l', text: 'motorcycle maintenance' },
  { id: 'm', text: 'GPU集群调度和显存监控。' },
];

if (import.meta.main) {
  const index = createIndex(documents);
  const originals = new Map(documents.map(document => [document.id, document.text]));
  const cases = [
    ...[
      '网关重启后为什么断连？', '网关', '索引', '索引擎', 'youer',
      '修改youer服务端配置', 'GPU显存', '网', '', 'the AND is please recall',
      'What time do I stop checking work emails and messages?',
      'vm', 'kvm', 'compaction', 'CompactionResult', 'moto', 'motorcycle',
      'gatway', 'gateway', 'gateway nonexistentword', '网关 不存在的词',
    ].map(query => ({ name: query || 'empty', query, options: { automatic: true } })),
    { name: 'total-before-limit', query: { concepts: [['gateway']] }, options: { limit: 1 } },
    { name: 'ascii-210', query: 'gateway' + ' '.repeat(203), options: { automatic: true } },
    { name: 'ascii-211', query: 'gateway' + ' '.repeat(204), options: { automatic: true } },
    { name: 'han-210', query: '网关' + '网'.repeat(103), options: { automatic: true } },
    { name: 'han-212', query: '网关' + '网'.repeat(104), options: { automatic: true } },
    { name: 'mixed-210', query: '网关 gateway' + ' '.repeat(198), options: { automatic: true } },
    { name: 'mixed-211', query: '网关 gateway' + ' '.repeat(199), options: { automatic: true } },
    {
      name: 'image-excluded',
      query: [{ type: 'image', data: 'x'.repeat(500), text: 'gateway' }, { type: 'text', text: 'youer' }],
      options: { automatic: true },
    },
    {
      name: 'attachment-already-in-text',
      query: [{ type: 'text', text: 'gateway' }, { type: 'text', text: '[attachment]\n' + 'x'.repeat(200) }],
      options: { automatic: true },
    },
    { name: 'long-active-tail-match', query: { concepts: [['gateway' + ' '.repeat(211)]] } },
    { name: 'same-long-automatic-skipped', query: 'x '.repeat(106) + 'gateway', options: { automatic: true } },
  ];
  try {
    console.log(JSON.stringify({
      prototype: 'SQLite FTS5 OR exact terms; native BM25, lower score ranks first',
      runtime: { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode, sqlite: process.versions.sqlite },
      documents: documents.map(document => ({ ...document, tokens: tokenize(document.text) })),
      searches: cases.map(({ name, query, options = {} }) => {
        const text = options.automatic ? extractText(query) : query.concepts.flat().join(' ');
        const result = index.search(query, options);
        return {
          name, query, text, weightedLength: weightedLength(text), options,
          ...result,
          results: result.results.map(hit => ({ ...hit, text: originals.get(hit.id) })),
        };
      }),
    }, null, 2));
  } finally {
    index.close();
  }
}
