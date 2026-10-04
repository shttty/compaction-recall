# 评测用工具提示词（冻结 v6）

v1 冻结：2026-10-03 19:30 CST。v2（19:55）：「中文拆双字」定为保留；新增 history_grep / history_expand 描述（凛音已审）。v3（22:36）：① 加「空格=AND，要 OR 就写 OR。」（凛音定；v2 正式第 2 组 SQLite 显式查询零命中 56–71%），②③④ 不变。v4（23:22）：v3 重跑后模型写 OR 的次数没变（英 3、中 4），零命中仍 53–64%；凛音定 SQLite 显式查询里裸词之间的空格由后端补成 OR，① 那行改为「空格=OR。」；上一行「原样执行」随之不再准确，改为「FTS5 MATCH 语法」。②③④ 不变。v5（10-04 10:00，凛音定）：① ② 加关键词上限 5，超了后端报错；「同义词、别称、译名」改为分几次查；「中文拆双字」换成「中文写2字词」——模型写过的中文词里 2 字 121/123 在索引、1 字 0/19、3 字 5/34、4 字及以上 0/26。① 参数说明的「原样执行」同步改为「空格=OR」。③④ 不变。v6（10-04 10:23，凛音定）：只改 ②。MiniSearch 字符串查询按空格切词，引号会黏在词上，`"San Francisco"` 变成 `"san`、`francisco"` 两个查不到的词（上一轮 62 次里 5 次带引号，例如 `"smart thermostat" "mesh"` 只剩 9 条）；后端改为去掉词里的引号和标点，提示词同步要求字符串查询不带引号和标点，「原样执行」随之删去。JSON 查询不受影响。①③④ 不变。改动须凛音确认，并升版本号。
位置：20:00 从 `~/.hermes/task-runs/recall-soft-match-20261003/history-recall-prompts.md` 移入本仓库 `doc/`，内容未改。计划见 `doc/SOFT_MATCH_EVAL_PLAN.md`。
用途：第 2 组评测，模型自写 query 调用 `history_recall`（autocut=false，`autocut` 不进 schema）。
`history_recall` 两份各属一个原型，不要求互相兼容；`history_grep` / `history_expand` 不走索引，两个原型共用一份。
只用于评测 harness。生产 `src/recall-extension.ts` 的描述（含 lite）不动；生产是否跟改另定。

## ① SQLite FTS5 原型（prototype/soft-match-sqlite）

工具描述：

```
搜当前分支压缩后历史。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
关键词匹配，非语义。
query = FTS5 MATCH 语法。空格=OR。
每次≤5个关键词，超了报错。同义词、别称、译名分几次查。
索引：中文=相邻双字+分词所得≥3字词；英文整词。
中文写2字词；1字查不到，3字以上多半不在索引。
零命中→换说法。没命中≠没说过。
命中 id→history_expand 读原文。正则/字面子串→history_grep。
```

参数：
- `query`：FTS5 MATCH 表达式，空格=OR
- `limit`：每页条数，默认 50，最多 50
- `offset`：翻页时填上一页返回的 nextOffset

## ② MiniSearch 原型（prototype/soft-match-minisearch）

工具描述：

```
搜当前分支压缩后历史。
范围：user/assistant 正文、assistant 工具调用名+参数。不含工具结果、思考、图片。
关键词匹配，非语义。
query = 字符串（空格切词，不带引号和标点）或 MiniSearch Query JSON。
每次≤5个关键词，超了报错。同义词、别称、译名分几次查。
索引：中文=相邻双字+分词所得≥3字词；英文整词。
中文写2字词；1字查不到，3字以上多半不在索引。
默认 OR、prefix 开、fuzzy 0.2；JSON 节点可覆盖。
零命中→换说法。没命中≠没说过。
命中 id→history_expand 读原文。正则/字面子串→history_grep。
```

参数：
- `query`：字符串（空格切词，不带引号和标点），或 MiniSearch Query JSON
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
