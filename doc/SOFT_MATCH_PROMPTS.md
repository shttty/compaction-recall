# 评测用工具提示词（冻结 v2）

v1 冻结：2026-10-03 19:30 CST。v2（19:55）：「中文拆双字」定为保留；新增 history_grep / history_expand 描述（凛音已审）。改动须凛音确认，并升版本号。
位置：20:00 从 `~/.hermes/task-runs/recall-soft-match-20261003/history-recall-prompts.md` 移入本仓库 `doc/`，内容未改。计划见 `doc/SOFT_MATCH_EVAL_PLAN.md`。
用途：第 2 组评测，模型自写 query 调用 `history_recall`（autocut=false，`autocut` 不进 schema）。
`history_recall` 两份各属一个原型，不要求互相兼容；`history_grep` / `history_expand` 不走索引，两个原型共用一份。
只用于评测 harness。生产 `src/recall-extension.ts` 的描述（含 lite）不动；生产是否跟改另定。

## ① SQLite FTS5 原型（prototype/soft-match-sqlite）

工具描述：

```
搜当前分支压缩后历史。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
关键词匹配，非语义。同义词、别称、译名自己写进 query。
query = FTS5 MATCH，原样执行。
索引：中文=相邻双字+分词所得≥3字词；英文整词。中文拆双字，OR 连。
零命中→换说法。没命中≠没说过。
命中 id→history_expand 读原文。正则/字面子串→history_grep。
```

参数：
- `query`：FTS5 MATCH 表达式，原样执行
- `limit`：每页条数，默认 50，最多 50
- `offset`：翻页时填上一页返回的 nextOffset

## ② MiniSearch 原型（prototype/soft-match-minisearch）

工具描述：

```
搜当前分支压缩后历史。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
关键词匹配，非语义。同义词、别称、译名自己写进 query。
query = 字符串（空格切词）或 MiniSearch Query JSON，原样执行。
索引：中文=相邻双字+分词所得≥3字词；英文整词。中文拆双字。
默认 OR、prefix 开、fuzzy 0.2；JSON 节点可覆盖。
零命中→换说法。没命中≠没说过。
命中 id→history_expand 读原文。正则/字面子串→history_grep。
```

参数：
- `query`：字符串，或 MiniSearch Query JSON，原样执行
- `limit`、`offset`：同 ①

## ③ history_grep（两个原型共用）

工具描述：

```
正则/字面子串搜当前分支压缩后历史。按关键词找线索先用 history_recall。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
pattern = JS 正则，不分大小写；正则非法→按字面搜。
片段有截断，读全文→history_expand。
没命中≠没说过。
```

参数：
- `pattern`：JS 正则，不分大小写
- `limit`：每页条目数，默认 30，最多 50
- `offset`：翻页时填上一页返回的 nextOffset

## ④ history_expand（两个原型共用）

工具描述：

```
按 id 读当前分支压缩后历史条目全文，附前后邻居。
id 来自自动提示、history_recall、history_grep。
含工具调用名+参数、可读的工具结果；不含思考、图片。
长条目分页，邻居只在目标读完时附上。
```

参数：
- `id`：条目 id
- `before` / `after`：前、后邻居条数，默认 2，最多 20
- `offset`：续读长条目时填上一页返回的 nextOffset，id 和 before/after 保持不变

## 已定

- ①② 里的「中文拆双字」保留（凛音，19:55）。
- 不补"索引无单字"（凛音，19:50）。

## 有意不写进提示词的内容

- 上下文编辑后的可见性（实现照样按上下文编辑过滤，只是描述里不提）。
- FTS5 / MiniSearch 通用语法讲解、示例、NOT/NEAR、引号转义、`*` 前缀、fuzzy 算法、报错处理（模型本身就会）。
- 依赖临时分词器 `Intl.Segmenter('zh')` 的写法约束（例如"整词只能 OR 附加"、"prefix 可从双字补到整词"）。这个分词器以后会换掉。
- grep/expand：16000 码点上限、片段数上限、total/covered/omitted 计数口径、超长元数据行跳过、"不是 SQL LIKE"。
