# 结构化工具参数原型（未接入生产）

问题：模型能否把确定条件与不确定线索分开，通过具名工具参数查询，而不手写 FTS5？本目录只回答接口与确定性检索语义问题，不代表检索质量、最终答题准确率或生产性能提升。

## 重跑

在仓库根目录，使用已锁定依赖和 Node 24+：

```sh
node archive/prototype/structured-tool-query/demo.mjs
node --test test/structured-tool-query.test.mjs
npm run check
```

第一条命令在真实 SQLite FTS5 内存库上执行六个合成示例，输出输入、编译结果、排序结果及进程/耗时采样；不读个人历史或配置，不写数据库。合成材料不来自 LME/hard8。

## 工具入口

`index.mjs` 导出 `description`、TypeBox `parameters`、`compileQuery(input)`、`createIndex(documents)` 与 `createTool(index)`。已有 Pi 扩展可直接调用 `pi.registerTool(createTool(index))`，调用方负责在结束时 `index.close()`；本原型不自动注册、不加载生产插件。

```js
import { createIndex, createTool } from './index.mjs';
const index = createIndex([{ id: 'note', text: '迁移 SQLite 前先备份。' }]);
try {
  const tool = createTool(index);
  const result = await tool.execute('example', {
    must: [{ any_of: ['迁移', '升级'] }],
    prefer: [{ any_of: ['SQLite'] }, { any_of: ['备份', '回滚'] }],
    exclude: ['Android'],
    limit: 20,
  });
  console.log(result.details);
} finally { index.close(); }
```

- `must`：组间 AND、组内 OR；只放确定的必要条件。
- `prefer`：有 must 时不缩小候选；没有 must 时用全部 prefer 的并集生成候选。正向条件全空报错，不扫描全集。
- `exclude`：任一字面项命中就排除，不理解语义否定。例如“暂不使用 SQLite”仍命中 SQLite。
- `limit`：默认 20，只接受正安全整数。不转字符串、不取整、不钳制；省略和显式非法值不同。
- `any_of` 必须是具名对象属性，且至少有一个字面项。未知字段、裸二维数组、空字面项等报带字段路径的错误。

`search` 返回 `{total, limit, results:[{id,text,preferGroups,score}]}`。`total` 是排除后、LIMIT 前的候选数；保留合成材料全文，不做片段裁剪、分页、去重或时间排序。文档 id 必须唯一。工具返回 `content` 中的 JSON 和相同的 `details`，不向模型输出 SQL。

## 排序是明确的组数优先，不是微小加权

对全部候选先按命中的 prefer **组数降序**，再按基础候选表达式的 SQLite BM25 升序，最后按文档插入顺序。每组在一篇文档最多计一次；同组多项命中或重复词频不多计组数。输入中重复列出的组仍是独立组，不自动纠正。must 存在时 BM25 只使用 must 表达式；prefer-only 时使用 prefer 并集。排除项只用于独立 rowid 过滤，绝不参与正向 BM25。

SQLite 的 MATERIALIZED 候选 CTE 保存 MATCH 游标内计算的 BM25；其他 MATCH 游标计算 prefer 各组命中，聚合组数后 JOIN、排除、排序，最后 LIMIT。没有先取前 20 再重排的近似。全部工作同步执行在当前线程；候选集、SQL 参数/复合 SELECT 数量受 SQLite 原生资源上限约束，不保证大语料延迟或可抢占超时，也不做隐式截断。

## 字面项与 tokenizer 边界

复用冻结原型的 `createHanPhraseTrial('off').tokenizer`，不修改它。索引和查询采用相同 token 流：Han 相邻双字、Han run 后的私有位置屏障、英文 camel/acronym/snake/dollar 分段和小写化；保留重复 token。查询每个字面项编译成一个转义后的 FTS5 引号短语，只去掉最后一个 Han 屏障，允许最终 Han 子串位于更长连续 Han run 中。没有词内双字 OR、字典扩展、词干化、同义词猜测或零命中放宽。

| 输入 | 行为 |
|---|---|
| `中华人民共和国` | 要求相邻双字的完整顺序；孤立的“共和”不足以匹配 |
| `哈哈哈` | 保留两个“哈哈”位置，不去重 |
| `共和，和国` / `共和 和国` | 内部屏障等价；不等于连续的“共和国” |
| `HTTPServer` / `HTTP server` | 均为 `http server`，不是标识符原文逐字匹配 |
| `修改youer服务端配置` | 混写按 Han/ASCII run 切分；“修改”后的屏障保留，空格有无不必改变 token 语义 |
| `备份 OR 回滚` | 一个包含英文 `or` 的短语，不是 OR 条件 |
| `say "hello"` | 引号是源文本分隔符；与 `say hello` token 等价，不产生查询语法 |
| `网`、`网关 x`、`foo_x`、`版本2` | 拒绝单 Han run 或单字符 ASCII 分段，不悄悄删掉一部分条件 |
| 空白、纯标点、纯 emoji | 零 token，报错 |
| `café`、日文假名、非 ASCII 数字/组合附加符 | 当前索引不保留的文字，查询拒绝 |
| NUL / U+E000 | 拒绝原生查询终止符与保留屏障 |

标点、空白、emoji 等非索引字符在含有效词的文本中充当分隔，不承诺逐字符匹配。文档 tokenizer 本身仍可丢弃单字符或未支持文字；查询侧更严格，避免把用户限制悄悄变成另一个限制。匹配源文档的已索引 token，不是正则或原文精确子串。

与现有路径的区别：复用了 SQLite Han phrase trial 的**无词干 tokens 表示**，没有复用 raw MATCH 接口、stems 列、jieba 排名、自动提示或 worker。旧 raw 路径仍由模型写 FTS5，本目录则只接受具名参数。相对于 `lexical.mjs` 默认 ICU 长词增强，本目录明确关闭长词增强；相对于正式 `src/locator.mjs` 的软覆盖检索，本目录是 token 短语加结构化布尔条件。不能拿本目录分数与旧路径分数直接比较。

## 真实模型试验

`model-requests.json` 预先固定六条独立中文请求；`model-trial.mjs` 使用已安装 SDK 的只读认证与原生工具机制，逐条隔离上下文。模型只看请求、工具 schema/description 和中性系统提示，不见语料全文、期望参数或答案；返回的工具调用才由实际 SQLite 执行。只观察首次工具选择/参数与输出，不做最终答题裁判、不重试或调参追分。

精确命令、实际模型/effort、逐条参数/结果、资源三表和验收证据在本次独立任务目录的 `REPORT.md`：`/home/rinne/.hermes/task-runs/recall-soft-match-20261003/research/structured-tool-query/`。小样本不能证明普遍接口易用性。未接入生产，未改变 package 发布内容、旧 raw 对照或历史评测。
