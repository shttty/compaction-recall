# 面向编码 Agent 的概念组查询

## 结论与边界

建议把模型侧接口定义为“概念组查询”，而不是让模型生成 MATCH 字符串，也不开放任意布尔 AST。模型只选择检索线索、同一线索的替代表述，以及是否要求所有线索共同出现。

这是一个待做端到端检索评测的接口设计，不是已经证明优于其他接口的结论。本包测试证明的是编译与匹配逻辑，不是模型检索质量。

此实现不访问网络、不调用模型、不生成 embedding、不推断同义词，不会自动扩大检索范围。适合在已有 worker 内调用。当前分支、已压缩范围、允许索引的消息类型等资格限制由应用固定控制，不由模型参数决定。

## 模型侧协议

```json
{
  "concepts": [
    ["worker_threads", "后台线程"],
    ["首次", "冷启动"],
    ["阻塞", "卡顿"]
  ],
  "match": "all",
  "exclude": []
}
```

`concepts` 是 1 至 5 个概念组。每组 1 至 4 个词面，表示同一检索线索的备选写法。组内命中任意词面就满足该概念，不要求所有备选词出现。

`match` 可选，默认 `any`。`any` 表示满足任一概念即可进入候选，适合首次召回；`all` 表示同一个 FTS 索引记录必须满足每个概念，适合缩小范围。它不是要求整段对话累计满足，也不会跨消息拼接命中条件。

`exclude` 可选，最多 5 条词面，默认空。命中任意一条就排除整条记录。其词面分析方式与正向线索相同。它不是降权，也不能表达“不是 X”“已经放弃 X”之类的语义否定。比如查询 WireGuard 并排除 OpenVPN，会删掉“从 OpenVPN 切换到 WireGuard”的关键历史。

同组不必是严格语言学同义词，但应是同一线索的替代表述。把两个独立要求放在同组，会把同时出现的要求变成二选一。

多词词面交给后端 `analyzeQuery` 分解。每条分析路径中的词项要求共同出现，不要求顺序或相邻。V1 不提供短语、原文精确子串、正则、前缀、NEAR、字段选择、权重或自动回退。

所有词面都是数据。输入 `OR`、`body:foo`、`foo*` 不会获得查询语法能力，但能否按原样匹配，取决于索引词项是否保存了这些信息。

## 为什么采用这个结构

自然语言查询字符串最短，但为了稳定执行，后端还需要一个额外解释器，或只能依赖模糊的关键词提取。这里不引入额外模型调用。

`all/any/phrase/exclude` 平面槽位比 MATCH 安全，但不容易表达“每个独立要求都有自己的替代词”。为了实现 `(A 或 B) 且 (C 或 D)`，很快又要增加嵌套。

任意布尔 AST 能表达更多内容，但也让模型面对更大的输出空间和更多无意义的组合。本协议只保留两层结构，让逻辑深度与查询大小有明确上限。

概念分组不是语义检索。没有写入索引、模型也没有列出备选词面的内容，不会因为字段叫 concepts 就被自动找到。

## 到 FTS5 的转换规则

对一个输入词面 s，后端返回有限个备选分析路径：

```ts
type QueryAnalysis = readonly (readonly string[])[];
type AnalyzeQuery = (surface: string) => QueryAnalysis;
```

外层是 OR，每条内层路径是 AND；每个叶子必须对应当前索引分词器下的一个词项。

```text
surface(s) = OR(AND(quote(atom) for atom in branch) for branch in analyze(s))
group(g)   = OR(surface(s) for s in g)
positive   = OR(groups)   当 match = any
positive   = AND(groups) 当 match = all
result     = positive NOT OR(exclusions)   当有排除词
```

每个复合表达式都显式括号分组。FTS5 的 NOT 是二元运算，并不是任意位置都能使用的一元 NOT。编译器拒绝没有正向条件的查询。

每个叶子用 FTS5 双引号包围，内部双引号写成两个双引号。这只解决 FTS 表达式层的转义；生成的整个 MATCH 字符串仍须通过 SQL 参数绑定传入，不能拼接进 SQL。

例如，当每个示例词面都对应一个真实索引词项时，前面的查询可读形式是：

```text
("worker_threads" OR "后台线程")
AND ("首次" OR "冷启动")
AND ("阻塞" OR "卡顿")
```

这只是可读示意。实际索引若使用下面的词项编码，最终 MATCH 的叶子会是编码后的 ASCII 词项。

## 分词适配：必须与索引对齐

`compileFts5(input, analyzeQuery)` 强制要求传入分析函数，故意不猜测你现有的中文和代码分词规则。索引时的扩展结果与查询时的约束，不应简单视为同一种输出。

假设索引同时保留标识符和拆分词，查询可以这样分析：

```ts
const analyzeQuery = (s: string) => {
  if (s === "worker_threads") {
    return [["worker_threads"], ["worker", "threads"]];
  }
  return [[s]];
};
```

正确语义是“完整标识符，或者组成词同时出现”，而不是要求 `worker_threads`、`worker`、`threads` 三个词全出现。后面的 `return [[s]]` 只适用于 s 本身就是索引词项的情况，不是通用分词器。

中文重叠双字也应如此理解：`主线程` 可以分析为 `[["主线", "线程"]]`。不要未经核实就拼成 FTS 短语 `"主线 线程"`，因为索引时插入的扩展词、去重或重排可能改变位置。AND 可以表达词项共现，但也可能命中原文不同位置的同一组双字；需要原文精确确认时必须另做校验。

FTS5 的双引号表达的是分词后的短语，不是逐字节比较。编译器无法仅凭字符串验证某个任意配置下的分词器是否将叶子视为一个词项。这个前置条件必须由后端分析器和索引配置保证。

### 可选的预分词词项编码

`token-codec.ts` 提供一个独立的索引适配器，把已经选定的词项编码成 `t` 加 UTF-8 十六进制。默认 unicode61 会把这样的字符串当作一个词项。这样可以保留供应给编码器的 `C++`、`C#`、下划线、路径符号和大小写，而不让 FTS5 再次拆开这些词项。

```ts
import { compileFts5 } from "./dist/query.js";
import { encodeDocument, encodeQueryAnalyzer } from "./dist/token-codec.js";

// 实际应用中由你现有的索引分析器提供这些词项。
const terms = ["worker_threads", "worker", "threads", "首次", "索引"];
const indexedText = encodeDocument(terms);

const rawAnalyzeQuery = (s: string) =>
  s === "worker_threads"
    ? [["worker_threads"], ["worker", "threads"]]
    : [[s]];
const analyzeQuery = encodeQueryAnalyzer(rawAnalyzeQuery);

const plan = compileFts5({
  concepts: [["worker_threads"], ["首次"]],
  match: "all"
}, analyzeQuery);
```

该编码器不是分词器。它不能补回索引分析器已经丢弃的符号，也不自动处理大小写、Unicode 规范化、词形或同义词。需要的规范化必须在索引端和查询端一致执行。编码后的“词项精确”也不等于原文中的连续子串精确。

这不是可单独加在查询端的补丁。启用它必须按同样编码重建相应 FTS 索引。已经能稳定保留独立词项的现有索引不必采用它。UTF-8 十六进制会扩大词项表示，真实内存与性能代价需要评测；本次没有做该对比。编码器保留重复词项，不擅自改变词频。

## 执行与集成

本包包含预编译 ESM 和 TypeScript 源文件。运行 demo 与测试不需要 npm 依赖，也不依赖 Node 的原生 TypeScript 执行。目标环境为 Node 24+，使用内置 `node:sqlite`。

```sh
npm test
npm run demo
```

已有 TypeScript 5.8+ 编译器时，可检查并重新构建：

```sh
tsc -p tsconfig.json
tsc -p tsconfig.build.json
```

编译结果仅提供 MATCH 参数，不接受或生成模型控制的表名、列名、SQL 或索引资格条件。

```ts
const plan = compileFts5(toolInput, analyzeQuery);
const rows = db.prepare(`
  SELECT rowid, bm25(recall_fts) AS score
  FROM recall_fts
  WHERE recall_fts MATCH ?
  ORDER BY score ASC, rowid ASC
  LIMIT ?
`).all(plan.match, 5);
```

此处假定 FTS 表只包含已获准检索的记录，不能只依赖 SQL 结果过滤来假装已经隔离索引统计。实际应用继续维持自己的分页、输出预算与资格边界；示例的 LIMIT 5 不是协议硬编码。

FTS5 BM25 的分数越小越相关，因此用 ASC。rowid 在这里只是稳定的同分排序键，不暗示时间先后。示例的 contentless 表返回 rowid，再从应用持有的原文映射读取消息；不会向 contentless 表索要原文。

示例建表保留 `columnsize=1`。不要在依赖 BM25 的 contentless 索引上随意去掉词数信息。

## 排序与查询必须分开看

普通 FTS5 BM25 并不知道哪些查询词属于同一概念。特别是在 any 模式下，分组的布尔成员关系可折叠成更平的 OR；仅仅换成概念组 JSON，不会自动产生“概念覆盖越多，排名一定越高”的效果。

本实现不声称提供概念公平权重。它返回 `groups`，供后续记录命中组、诊断或单独实验重排。需要覆盖组数优先时，应按组计算是否命中，再在重排层使用这个信号；不要重复词项来假装实现权重。

在有限候选上重排只是近似方案：早先被截断的高覆盖结果不会被凭空找回。因此候选预算本身也应评测。不同 MATCH 查询的 BM25 分数也不要未经校准直接混排。

本版本没有隐藏回退。all 查不到就是查不到；模型可明确发出新的 any 查询，但编译器不会擅自改变前一次调用的语义。

## 校验与资源上限

运行时拒绝未知字段、错误的 JSON 形状、空查询、仅排除查询、空词面、不支持的控制字符、未配对的 UTF-16 代理项及非法分析结果。输入修剪首尾空白，不做 Unicode 规范化。

上限为 5 个概念组、每组 4 个词面、5 个排除词面；单词面 256 个 Unicode 码点，全部词面合计 2048 个码点。后端分析最多 4 条备选路径、每路径 16 个词项，总展开预算 256 个词项，最终 MATCH 最多 32768 个 UTF-16 代码单元。

重复词面、相同编译子句会去重；不会为了通过上限而静默截断。分析后没有词项时返回 `EMPTY_ANALYSIS`，正向词和排除词都不会被偷偷丢弃。输入校验由 `parseQuery` 执行，JSON Schema 仅承担工具侧形状提示与初步约束。

## 已执行验证

实际测试环境：Node v22.16.0、SQLite 3.49.1；TypeScript 5.8.3 严格类型检查和 ESM 构建通过。本次没有完成 Node 24/26 的实机复测，不能将目标版本列作已测试版本。

30 个测试全部通过。测试既比较编译结果，也实际创建内存 FTS5 表执行查询。其中包括：

- 4096 种词项组合 × 30 种查询配置的布尔真值表检查。
- 1000 个固定种子的特殊词面经编码后的往返匹配，以及另外 1000 个原始特殊字符串的 FTS 双引号转义执行检查。
- 中文双字共现、完整标识符/拆分词的替代关系、全局排除、禁止隐式回退、不能跨记录满足 all、contentless 表与 detail=none 的相关匹配用例。

完整记录见 `test-results.txt`，运行时信息见 `test-environment.json`，示例输出见 `demo-output.json`。这些是功能与边界测试，不是延迟基准，也不是实际历史记录的召回率评测。

## 建议的质量实验

固定索引、分析器、模型、提示词预算、结果条数、输出预算和测试任务。对比安全转义的关键词 OR、平面槽位接口、概念组接口，避免把索引或分词改动混入接口实验。

任务应以真实已压缩历史和可核验的目标消息 ID 为依据。主要看首次 Recall@5、最终证据定位正确率、零结果率、参数与语义错误率、总工具调用次数、输入输出 token 数。检查模型是否把不同要求误放到同组，是否过早选 all，是否误用 exclude，以及是否只生成不可能出现在原文中的自然语言概括。

先验证模型是否正确使用协议，再决定是否增加前缀、精确匹配或重排。不要把功能清单长度当作检索效果。

## 依据

SQLite 官方 FTS5 文档：查询语法、字符串转义、布尔优先级、分词、contentless 表与 BM25。
https://sqlite.org/fts5.html

Node.js 官方 SQLite 文档：DatabaseSync、预备语句与参数绑定。
https://nodejs.org/api/sqlite.html

Anthropic 工具设计实践：任务导向的工具设计、原型验证和真实任务评测。该文章不证明本协议的效果优于其他方案。
https://www.anthropic.com/engineering/writing-tools-for-agents
