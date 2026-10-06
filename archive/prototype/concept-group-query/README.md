# 上传概念组方案：独立 SQLite 试验

本目录测试作者上传的 `query.ts` 与 README，不是 must/prefer 的改版，不接生产。

## 原文件与缺口

`original/` 两份文件逐字节保留：

| 原始文件名 | 本地副本 | SHA256 |
|---|---|---|
| `doc_83fafd9bd82c_query.ts` | `original/query.ts` | `ee35b838e82db1f4a2fc559565f86f6ee4c0ace9ad5a887f526c9390084df914` |
| `doc_cb6a7d181243_README (1).md` | `original/README.md` | `8af876be43e11b3749fc54bf52838fedf05694f8b8bfc63cfff425a842841266` |

没有收到作者的 schema、token-codec、dist 或原始 30 项测试；不声称复跑原包。本机 Node 24 直接执行原始 TypeScript（内置类型擦除），没有重写编译器或伪造编码器。作者 README 中的环境及测试结论仅属作者原始陈述。

## 运行

仓库根目录，复用已安装依赖：

```sh
node archive/prototype/concept-group-query/demo.mjs
node --test test/concept-group-query.test.mjs
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target esnext --module nodenext --skipLibCheck archive/prototype/concept-group-query/original/query.ts
npm run check
```

`demo.mjs` 只读 import 旧组的 16 篇合成便笺，不复制语料。20 项新增测试包含真实 SQLite FTS5 查询、前置 analyzer 契约及原编译器校验；不是检索质量/最终答题评分。

## 接口与执行

`createTool(createIndex(documents))` 提供原生 `structured_recall` 工具，具名参数只有：

- `concepts: string[][]`：1–5 组，每组 1–4 个替代词面；组内 OR。
- `match?: 'any' | 'all'`：默认 any，组间 OR；all 要求同一记录满足全部组。
- `exclude?: string[]`：默认空，最多 5 条，任一命中即硬排除。

校验、trim、去重及所有 LIMITS 由原始 `parseQuery`/`compileFts5` 执行，不截断、不放宽。schema 是依据上传 README 与源码新建的包装，不冒充缺失的原 schema。

没有 must/prefer、权重、limit、短语、语义否定或隐式回退。最多返回 20 条由包装器固定，不能表达“最多三/四条”或同时硬约束与软偏好。排序为原 MATCH 的 BM25 ASC、rowid ASC，不做组数优先重排。NOT 保留在原编译 MATCH 内，未改成旧组的 SQL 外部排除。BM25 在 MATERIALIZED CTE 内计算，再统计总数与排序分页，避免窗口函数上下文中调用 FTS 辅助函数；这是包装器接入修复，不是作者编译器改动。

## analyzer 与索引契约

复用 `createHanPhraseTrial('off').tokenizer`，索引同旧组：内存 FTS5、contentless、`tokenize='ascii'`、默认 columnsize=1。未增加词典、jieba、词干、原始标识扩展或编码。

索引保留 Han run 位置屏障 U+E000；查询移除**所有**屏障后，以余下真实词项构成一条 AND 路径。屏障不是正向检索线索。原作者明确采用共现，故 `共和国` 能命中 `共和，和国` 和反序的 `和国，共和`；不是相邻短语，更不是原文连续子串。

技术标识在现有索引中仅保存拆分词，如 HTTPServer → http/server，retry_delay → retry/delay。主 analyzer 不生成不存在的完整标识词项，也不把索引扩展全部强行 AND。原编译器的“完整词项 OR 拆分 AND”能力另用直接写入真实词项的独立 FTS5 契约夹具验证；该夹具不是模型试验语料或另一套分析词典。

tokenizer 原有损失保持不变：单 Han、单字符 ASCII 分段、标点及未支持字母不会写入索引；全零词项触发原编译器 EMPTY_ANALYSIS（正向和排除都一样）。混合输入如 `雪松 中 C++` 只留下雪松，不能将单字符丢失归因于概念组接口。原子经 fts5vocab 检验，与实际 ascii 分词词项对齐；保留双引号的专用 tokenizer 夹具另验证作者转义，不声称共享索引保留引号。

## 模型试验与证据

`model-trial.mjs` 从旧组已验证 runner 最小复制修改：仅改试验身份、产物路径、只读请求/语料 import、源码指纹清单及临时目录前缀。保留 `import.meta.resolve` / `findPackageJSON`、SDK 只读认证、中性系统提示、单题独立 Agent、一次原生工具轮、无重试/续答/裁判。工具名称与旧组保持一致。

请求直接读取 `../structured-tool-query/model-requests.json`，SHA256 为 `f15bb1e13e106ce890963eb8f48e18780c83f1ba52e433d48066ade1dcb2762e`。模型不见语料全文、预期参数或答案。真实调用要求显式 `--profile PATH --provider clp --model gpt-6-luna --effort high --output PATH`；不要无授权重跑。profile 只交给 SDK，不读取、打印或复制凭据。

本次证据及中文报告：`/home/rinne/.hermes/task-runs/recall-soft-match-20261003/research/concept-group-query/`。旧组证据只读引用同级 `structured-tool-query/`。接口、词面 AND/phrase、排序策略一起不同，不能作为纯接口因果 A/B 或质量榜单。
