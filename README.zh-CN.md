# compaction-recall

[English](README.md) | [简体中文](README.zh-CN.md)

Pi 压缩长对话后，摘要可能丢掉名字、数字和原话。compaction-recall 让模型搜索当前分支被压缩掉的原始消息，再展开证据核实。

**0.1.0 目前是本地发布准备；本任务没有发布 npm 包或 release tag。** 默认 `full` 使用原生 Node worker 内的 **SQLite FTS5 内存索引**，不接管 Pi 压缩，不持久化索引、不生成 db/WAL/SHM 文件、不额外调用模型。`lite` 只有正则 grep 和展开工具，没有 worker 或自动提示。

## 要求与本地使用

需要 **Node.js >=24.18.0**；已核对宿主 **Pi SDK 1.0.0**。SDK 与 `typebox` 由宿主提供、维持 peer；唯一生产 npm 依赖是 `@node-rs/jieba`，仅在 worker 加载。

检出源码后安装锁定依赖，再临时加载一个入口，不改 Pi profile：

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

也可以 `pi -e /absolute/path/to/compaction-recall`。Pi 不替本地目录安装依赖，应先安装；Pi 管理的 npm/git 包会安装声明的依赖。`pi install` 会改 settings，本任务未执行。`src/index.ts` 和替代入口 `src/recall-extension.ts` 只选一个，不要重复注册。

## 工具与配置

压缩后，`full` 在回答前给模型几条词面定位提示，由模型决定是否继续取证：

- `history_recall({concepts, match?, exclude?, limit?, offset?})`：1–5 个概念组，每组 1–4 个替代词面。默认 `any` 组间 OR；`all` 要求每组在同一记录命中。一个词面分析出的词项要求共现，不要求短语顺序。例如 `{"concepts":[["bicycle","bike"],["repair","service"]],"match":"all"}`。
- `history_expand({id, before?, after?, offset?})`：读取当前分支编辑生效后的原文，长条目可翻页。
- `history_grep({pattern, limit?, offset?})`：证据不足时独立使用 JavaScript 正则搜索。recall 不暗中切换为字面扫描或 grep。

FTS 决定候选。生产固定已测的英文 Porter＋纯汉字双字策略。worker 默认启用 jieba，仅利用既有词典长词表加一项 SQL 排名信号：正向、纯汉字、至少三字词面的不同命中数优先，其次 BM25 和原时间/recency/rowid ties，**先排序再分页**。exclude 不加分，候选不扩大。自动选词不变；已测纯双字自动词项通常不具有中文长词加分。不承诺语义或同义词扩展。

部分 token 损失继续按分析词项搜 FTS，并返回短 warning；零 token 保留 compiler 错误。正常零命中仍是零结果。recall 每页默认最多 50 条、目标预算 16,000 Unicode 码点，续页必须用返回的 `nextOffset`。

可选 agent 级文件 `<agent-dir>/extensions/compaction-recall.json`（默认 agent 目录 `~/.pi/agent`）：

```json
{
  "mode": "full",
  "jieba": true,
  "autoGate": 280,
  "snippetBudget": 240,
  "recallTimeoutMs": 5000,
  "trace": false,
  "preindex": { "userCycles": 10, "toolRounds": 10 }
}
```

自动门槛和片段预算中 Han 码点权重 2，其他码点 1。自动查询过长时跳过提示，主动 recall 不受这个门槛限制。超时是协作式：native MATCH 不可抢占，但过期结果会丢弃，健康 worker 缓存不清空。

```sh
COMPACTION_RECALL_MODE=lite pi -e ./src/index.ts
COMPACTION_RECALL_JIEBA=off pi -e ./src/index.ts
```

环境覆盖还包括 `COMPACTION_RECALL_AUTO_GATE`、`COMPACTION_RECALL_SNIPPET_BUDGET`、`COMPACTION_RECALL_QUERY_TIMEOUT_MS` 及原预热节奏变量。配置只在扩展加载时读取，改后需重载。`PI_CODING_AGENT_DIR` 选 agent 目录，不跟随 cwd 或 SDK 的 `agentDir` 选项。生产不读旧 SQLite trial/arm 变量。完整规则见仓库的 [PLUGIN 说明](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md)。

## 范围与隐私

只搜**当前分支**的已压缩用户/助手正文及助手工具调用名/输入。thinking、图片、工具结果正文和压缩摘要不入搜索；可读工具结果仍可按 id 展开。最新 context edit 生效：省略条目不可见，替换内容遮住原文。不跨 session 或被放弃的分支。

提示和工具结果可能发送给模型 provider。`lite` 不注入隐藏提示，但不是“历史永不发送”的隐私开关。查不到不证明不存在。worker 失败直接暴露错误，不切换检索算法；shutdown 等待 worker。可选计时只写显式指定的文件；文件配置 `trace: true` 会记录带内容的结构化输入，应按敏感文件处理。

## 冻结评测与历史性能

[0.1 benchmark 索引](https://github.com/shttty/pi-context-recall/tree/main/benchmark/archive/release-0.1.0) 公开来源、处理、固定输入hash、runner与非正文指标，并按用户授权保留 **16 道冻结中文题面译文**。英文原题、参考、模型回答、裁判理由和检索摘录留外部。LME 原题可按上游ID提取；逐字复现翻译历史、修订参考、本地派生SWE题集及冻结输出需匹配hash的外部资产，不能称只凭链接可复现96份答案。SWE最新机器严格结果仍为 **7/8**，sw08人工认可独立。benchmark不入npm。

更早的 JS 版本结果仍在 [BENCHMARK_RESULTS](doc/BENCHMARK_RESULTS.md)，旧内存/耗时表在仓库 [PERFORMANCE](https://github.com/shttty/pi-context-recall/blob/main/archive/doc/PERFORMANCE.md)。它们是**历史记录，不是本次 SQLite 生产版本的测量**，不能当作当前内存/延迟承诺；小样本单轮评分也不证明稳定准确率。旧 JS 运行时与原说明保留在 git 归档，不进包。

## 开发

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

检查使用离线合成 fixture 与隔离 agent 目录。真实评测需要显式外部配置和另行授权。

## 许可

MIT。数据/软件归属、SWE-chat 数据库许可与单条内容权利区别见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。benchmark 仅入 git；完整历史、凭据、profile、provider wire 不打包。
