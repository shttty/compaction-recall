# MiniSearch 软匹配原型

独立、可丢弃的内存搜索原型；不注册生产插件、不读会话/profile、不调用模型、不建服务。与 SQLite 方案能力有意不同，不是仅换引擎的等价性能对照；本轮不下性能胜负结论。

## 运行与版本

在仓库根目录运行：

```sh
# 依赖已安装；重建时只使用本目录的 manifest、lock、node_modules 和缓存。
npm ci --prefix ./prototype/soft-match-minisearch --ignore-scripts --no-audit --no-fund --cache ./prototype/soft-match-minisearch/.npm-cache
node prototype/soft-match-minisearch/demo.mjs
node --test test/soft-match-minisearch.test.mjs
```

- npm `minisearch` **7.2.0**，无间接依赖；`package.json` 固定版本，`package-lock.json` 固定 tarball 和 SHA-512 integrity。
- 实测 **Node v24.18.0 / ICU 78.3 / Unicode 17.0**。复现分词、分数时使用此组合；ICU 不由 npm 锁定，不同 Node/ICU 的词语边界可能变化。demo 主入口使用 `import.meta.main`，要求 Node >=24.2。
- 先核对了[官方 README](https://github.com/lucaong/minisearch#readme)、[SearchOptions API](https://lucaong.github.io/minisearch/types/MiniSearch.SearchOptions.html)、[Options API](https://lucaong.github.io/minisearch/types/MiniSearch.Options.html)，并核对本地安装的 7.2.0 源码。

## 接口与语义

`index.mjs` 导出 `tokenize(text)`、`weightedLength(text)`、`extractText(content)`、`createIndex([{id,text}])`。文档使用唯一字符串 id 和字符串 text；返回对象提供：

```js
const index = createIndex([{ id: 'a', text: '网关重启后断连。' }]);
const answer = index.search('网关为什么断连？', { automatic: true, limit: 20 });
// { skipped, total, results: [{ id, score, terms, queryTerms, match }], queryTerms? }
index.close();
```

- 每个连续 `Script=Han` 段产出相邻双字，同时按 `Intl.Segmenter('zh', {granularity:'word'})` 取 `isWordLike`、纯 Han、至少两个码点的词语。二字词的同位置同跨度已由双字产出，只计一次；不同位置保留词频。按原文位置、短跨度优先；同一词项空间，无单字列、无额外 trigram 层。三字词可以来自词语层，例如 `独角兽` → `独角, 独角兽, 角兽`。
- 英文/数字/下划线按 `[A-Za-z0-9_]+` 整词小写，复制 `src/locator.mjs` 英文停用词的同值集合，不过滤中文停用词。中英紧邻分开；不拆 camelCase，不提取标识符内部子串，不 stemming。分词不调用生产 `lex/queryTerms`。
- 索引和查询使用同一分词规则；仅查询去重。文档真实频次交给 MiniSearch。`storeFields: []`，不在索引里保存可展开的全文副本；demo 用 fixture 的 id→原文映射展开。
- `search` 接收字符串或消息 content 块数组。字符串原样；仅 `type:'text'` 且 text 为字符串的块按顺序以换行连接，图片等块忽略。自动查询在分词、停用词过滤、去重之前计数：Han 码点 2，其余码点 1，包括空格、标点和换行。**仅权重 >210 才 skipped**，不截断搜索。主动查询无此长度限制。附件已并入 text 则照常计数，没有额外附件识别。
- 原生 `combineWith:'OR', prefix:true, fuzzy:0.2`；无最低命中比例或 AND 门槛。保留 BM25+ 默认 `k=1.2,b=0.7,d=0.5`、prefix/fuzzy 默认权重 `0.375/0.45` 和原生匹配查询词数量乘数。MiniSearch 的字段长度归一化使用不同词项数，词频本身仍保留。没有额外自定义评分；只在同分时以 id 的 JS 字符串顺序稳定排序。
- `total` 是截取 `limit` 前的全部引擎候选数；`limit` 默认 20，使用非负整数，0 可只取 total。无词项返回 `skipped:false,total:0,results:[]`。`close()` 释放索引引用，可重复调用，关闭后搜索抛错。无数据库、文件索引或后台资源。

## 实际验证结果

已实跑上述两个 node 命令：demo 退出 0、stderr 为空；**34 个测试全部通过**。完整 demo JSON 见 [demo-output.json](./demo-output.json)，包含 a–m 原文、分词、原生分数、匹配词和门闸结果。以下按实际排名列 id：

| 查询 | 命中 |
| --- | --- |
| 网关重启后为什么断连？ | a, b |
| 网关 | b, a；不命中含标点的 c |
| 索引 / youer | d / e |
| 历史英文demo查询（原题已外置，非当前demo题面） | k，历史score 51.07078430797302 |
| vm / kvm | g / h, g |
| compaction / CompactionResult | f / f |
| result | 无；不额外拆出 Result |
| moto / motorcycle | l / l |
| gatway / gateway | j, i / j, i |
| gateway qzxwvvnonexistent | j, i，存在词加不存在词仍能召回 |
| 网关火星独角兽 | b, a |
| GPU集群 / gpt | m / m |
| 空串、单汉字、全英文停用词、独立图片 | 正常空结果 |

门闸验证：ASCII 210 放行、211 跳过；纯 Han 210 放行、212 跳过（纯 Han 权重只能为偶数）；混合 210 放行、211 跳过。图片不计数，text 块间换行计数；附件 text 权重 232 时自动跳过。主动查询权重 218、匹配词位于 210 之后，仍命中 j/i。测试另覆盖补充平面码点、停用词/重复词/纯空格超限、文档词频、查询去重、默认返回 20 但 total 为 25、同分 id 排序及关闭行为。

## 确定的限制与假阳性

- fuzzy 使用库原生 `min(6, round(term.length * 0.2))`；这里的 `term.length` 是 JS **UTF-16 单元数**，不同于自动门闸的码点计数。BMP 中文双字或两字符英文的距离为 0，三字符词为 1；不另设短词阈值。补充平面 Han 的 UTF-16 长度更大，不能套用“两码点必为距离 0”的结论。
- **短英文假阳性已观察到**：`kvm` → `vm`（g，score 1.2042433533880228）；反向 `vm` 不命中 kvm。`gpt` → `gpu`（m，score 0.9543707153977823）。这是原生模糊扩展，不是内部子串匹配。
- **中文风险已观察到**：独立合成文档 `独兽` 被查询 `独角兽` 的三字词 fuzzy 命中，score 0.12945693260330138；两个查询双字 `独角/角兽` 均非文档词项。长词扩展因此能引入双字假阳性，不能只看双字自身距离为 0 就认为中文精确。
- 双字跨语言学词边界但不跨标点：测试用只有 `搜索引擎` 的独立文档证明 `索引` 也能命中。共同样本 d 中 `索引` 出现两次，其中一次来自该交界；与真实“索引”含义可能混淆。prefix 同样允许两字前缀命中更长词。
- `compaction` 命中 `CompactionResult`、`moto` 命中 `motorcycle` 是保留的 prefix 能力；没有强行对齐 SQLite 的命中集合。OR 召回只表明有词面关联，不证明整句、实体或意图匹配；不保证中文分词、语义同义词或真实会话检索质量。

仅改本原型目录和新增 `test/soft-match-minisearch.test.mjs`；未改生产插件、根依赖、冻结结果或相邻原型。未运行 LongMemEval、模型评测或大规模性能矩阵。
