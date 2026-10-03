# SQLite FTS5 soft-match 原型

独立、可丢弃的匹配行为实验；不接生产插件、hook、worker 或用户 profile。只查合成文本，不调用模型。本方案是 **OR 精确词项 + SQLite 原生 BM25**，不是 MiniSearch 宽松匹配的等价替换，不作性能胜负结论。

## 运行与版本

仓库根目录执行，无需安装依赖：

```sh
node prototype/soft-match-sqlite/demo.mjs
node --test test/soft-match-sqlite.test.mjs
```

复现版本固定为本轮实际宿主：**Node v24.18.0 / ICU 78.3 / Unicode 17.0 / SQLite 3.53.1**，FTS5 已实测可用。npm 依赖为零，仅使用 Node 内置模块，因此没有 npm lockfile，也未修改根依赖。词典切分由该版本 ICU 决定；其他版本未经验证，不自动下载或更换宿主。

Demo 输出一份 JSON：运行版本、a–m 原文及分词、查询提取文本与加权长度、去重 queryTerms、skipped、全部候选数 total、命中 id/原始 BM25 分数及原文展开。两条命令在上述宿主均未观察到 SQLite 实验警告，未压制 stderr；其他 Node 版本若发出警告会原样显示。

## 接口与语义

`index.mjs` 导出：

- `tokenize(text): string[]`：文档保留词频；查询使用同一函数后按首次出现顺序去重。
- `weightedLength(text): number`：按 Unicode 码点，Han 权重 2，其余权重 1，空格、标点、换行及 emoji 均计入。
- `extractText(content): string`：字符串原样返回；数组只提取字符串类型的 `text` 块，按原顺序以换行连接；图片和其他块忽略。
- `createIndex([{id, text}])`：输入使用唯一字符串 id 和字符串 text；返回 `search(query, {automatic=false, limit=20}={})` 与 `close()`。query 可为字符串或消息 content 块数组，结束后调用 close。
- `search` 返回 `{skipped, total, results: [{id, score}], queryTerms}`。limit 为非负安全整数；`limit: 0` 仍返回真实 total。空查询、全英文停用词、单 Han 字无词项时正常返回空，不执行无效 MATCH。

分词规则：

1. 每个连续 `\p{Script=Han}` 段生成相邻双字；不跨标点、中英边界或其他非 Han 字符。另对每段调用 `Intl.Segmenter('zh', {granularity:'word'})`，只接受 isWordLike、纯 Han、至少两个码点的词。
2. 两字词与同位置双字完全重合，只记一次；不同位置的重复仍计频次。按原文位置、短跨度优先排序，所有词共用命名空间。不加单字或滑动 trigram；ICU 确实产出的三字及更长词仍保留，例如本机的“共和国”。
3. `[A-Za-z0-9_]+` 为完整小写词项，包括一字符 ASCII 词；不拆 camelCase、不做内部子串、stemming 或前缀。英文停用词是 `src/locator.mjs` 英文集合的同值副本，不使用生产 queryTerms/lex，不过滤中文停用词。
4. 自动查询先 extractText，再在分词、停用词过滤和去重前计长：**大于 210 整次跳过，等于 210 允许**；不截断后搜索。主动查询没有此闸，也不截断尾部。独立 image 块不计；已经拼入 text 的附件文字正常计入，块间连接的换行也计入。

## 内存索引

只有一个 `new DatabaseSync(':memory:')` 和一张主 FTS5 虚表：

```sql
CREATE VIRTUAL TABLE terms USING fts5(
  tokens, content='', columnsize=1, detail=full,
  tokenize="ascii tokenchars '_'"
);
```

预分词结果以 ASCII 空格连接。FTS5 的 ascii tokenizer 保留非 ASCII Han 词项，显式 tokenchars 保留下划线；已实测 `foo_bar`、`_`、扩展区 Han 和重复词频不会被拆坏。contentless 不存原文或完整预分词文本副本，保留倒排频次、位置及 BM25 所需文档长度元数据；JavaScript 仅保留 rowid → id 映射。原文由 demo 的输入文档持有，展开时按 id 查回。

`temp_store=MEMORY`；不生成数据库、WAL、SHM 文件。构建为一次事务，close 释放连接。没有持久化、增量更新或服务。

每个 MATCH 词项双引号包裹、内部双引号转义，再用 OR 连接并绑定参数；无命中比例门槛、强制 AND、fuzzy、前缀、trigram tokenizer 或 LIKE 补救。SQLite `bm25(terms)` 原始分数为负，**越小越优先**；JavaScript 按该分数排序，同分按字符串 id 的确定性顺序排序。取出全部候选再应用 limit，total 不是返回数量；此原型不优化海量候选的内存/排序开销。

## 实际验证

上述 demo 运行成功；独立测试最终 **11/11 通过，0 失败**。首轮 10/11，唯一失败来自测试猜测“服务端”是 ICU 整词；原生探测为“服务 / 端 / 配置”。删除该猜测断言，改查中英边界的 ASCII 整词不被吞并，没有为过测试修改分词实现。

a–m 共同样本的实际结果，id 按 demo 排序：

| 查询 | 命中 |
| --- | --- |
| 网关重启后为什么断连？ | a, b |
| 网关 | b, a；不含标点隔开的 c |
| 索引 | d；文档中两个不同位置的“索引”均保留频次 |
| youer | e |
| 修改youer服务端配置 | e, b（b 只共享“配置”） |
| GPU显存 | m |
| What time do I stop checking work emails and messages? | k，score = -7.8939042424680315；不存在的 time/messages 不阻断候选 |
| vm / kvm | 分别仅 g / h |
| compaction / CompactionResult | 分别无 / f |
| moto / motorcycle | 分别无 / l |
| gatway / gateway | 分别无 / j, i |
| gateway nonexistentword | j, i |
| 网关 不存在的词 | b, a |
| 单字网、空串、全英文停用词 | 正常空结果，skipped=false |

测试还验证：仅有“搜索引擎”的文档可由相邻双字“索引”命中，而“搜索，引擎”不可；多字词、同跨度去重、重复词频影响 BM25、长度归一化、下划线和单字符 ASCII 整词、MATCH/SQL 外观输入、安全空词项、同分 id 顺序及真实 total。

ASCII / Han / 混合输入均覆盖 210 边界：ASCII、混合 211 跳过，纯 Han 下一个长度 212 跳过；附加覆盖停用词/重复词去重前计数、非 BMP Han、emoji、独立图片排除、附件 text 210/211（包括连接换行），以及超过 210 且命中词在尾部的主动查询。`gateway` 配合 `limit:1` 的 demo 返回 1 条但 total=2。

## 确定的限制

- 这是词面召回，不理解语义或短语约束。OR 会保留仅命中少量词的候选；上述“重启断连”查询中的 b、“修改youer…”中的 b 均非相关事实证据。双字还可能跨词边界形成偶然命中，例如“搜索引擎”中的“索引”。
- 错字、英文前缀/内部子串及单 Han 字不补救；不能由 gatway 推出 gateway，也不能由 compaction/moto 推出完整标识符/单词。无结果不代表历史没有相关语义。
- 同时索引双字与词语会影响 BM25 的词频和文档长度；分数不是概率，不应与另一引擎直接比较。ICU 升级可能改变多字词和排名。
- 未运行 MiniSearch、LongMemEval、大规模性能矩阵或模型评测；不对另一原型的假阳性、速度、内存或准确率作未验证陈述。
