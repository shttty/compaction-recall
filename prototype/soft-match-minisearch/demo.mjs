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

export const queries = [
  '网关重启后为什么断连？', '网关', '索引', '索引擎', 'youer',
  '网', '', 'the AND is please',
  'Does the maintenance manual cover motorcycle inspections?',
  'vm', 'kvm', 'compaction', 'CompactionResult', 'result',
  'moto', 'motorcycle', 'gatway', 'gateway',
  'gateway qzxwvvnonexistent', '网关火星独角兽', 'GPU集群', 'gpt',
];

export const gateCases = [
  { name: 'ASCII 210', query: 'gateway' + ' '.repeat(203), automatic: true },
  { name: 'ASCII 211', query: 'gateway' + ' '.repeat(204), automatic: true },
  { name: 'Han 210', query: '网关' + '汉'.repeat(103), automatic: true },
  { name: 'Han 212', query: '网关' + '汉'.repeat(104), automatic: true },
  { name: 'mixed 210', query: '网关gateway' + ' '.repeat(199), automatic: true },
  { name: 'mixed 211', query: '网关gateway' + ' '.repeat(200), automatic: true },
  { name: 'image excluded', query: [{ type: 'image', text: 'x'.repeat(1000), data: 'x'.repeat(1000) }, { type: 'text', text: 'gateway' }], automatic: true },
  { name: 'text block separator 210', query: [{ type: 'text', text: 'gateway' }, { type: 'text', text: ' '.repeat(202) }], automatic: true },
  { name: 'attachment in text counted', query: [{ type: 'text', text: 'gateway\n[attachment]\n' + 'x'.repeat(211) }], automatic: true },
  { name: 'long active query, match at end', query: ' '.repeat(211) + 'gateway', automatic: false },
];

function runDemo() {
  const index = createIndex(documents);
  const byId = new Map(documents.map(doc => [doc.id, doc.text]));
  const report = (query, options = {}) => {
    const text = extractText(query);
    const response = index.search(query, options);
    return {
      text, automatic: options.automatic ?? false, weightedLength: weightedLength(text),
      // Diagnostic only: search itself checks the gate before tokenization.
      tokens: tokenize(text), ...response,
      results: response.results.map(result => ({ ...result, text: byId.get(result.id) })),
    };
  };
  try {
    const risks = createIndex([{ id: 'han-deletion', text: '独兽' }]);
    let hanRisk;
    try {
      hanRisk = {
        documents: [{ id: 'han-deletion', text: '独兽', tokens: tokenize('独兽') }],
        query: '独角兽', tokens: tokenize('独角兽'), ...risks.search('独角兽')
      };
    } finally {
      risks.close();
    }
    console.log(JSON.stringify({
      runtime: { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode },
      engine: { name: 'minisearch', version: '7.2.0', combineWith: 'OR', prefix: true, fuzzy: 0.2, storeFields: [] },
      documents: documents.map(doc => ({ ...doc, tokens: tokenize(doc.text) })),
      searches: queries.map(query => report(query)),
      gateCases: gateCases.map(({ name, query, ...options }) => ({ name, ...report(query, options) })),
      hanFuzzyFalsePositive: hanRisk,
    }, null, 2));
  } finally {
    index.close();
  }
}

if (import.meta.main) runDemo();
