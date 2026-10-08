# compaction-recall

[English](https://github.com/shttty/compaction-recall/blob/main/README.md) | [简体中文](https://github.com/shttty/compaction-recall/blob/main/README.zh-CN.md)

一个让 AI agent 从已压缩对话中找回细节的扩展。

摘要可能丢掉名字、数字和原话。compaction-recall 让模型搜索当前分支的原始消息，再展开相关证据，不替换 agent 自身的压缩机制。

- **本地内存检索**：SQLite FTS5 在 Node worker 中运行，不持久化索引，不需要 embedding 服务，也不额外调用模型。
- **支持中英文**：使用英文词干和汉字双字索引，可选 jieba 长词排名，在已有命中中优先返回相关记录。
- **两种模式**：`full` 提供自动历史提示和三个工具；`lite` 只保留 grep 与原文展开，不启动索引或 worker。

## 安装

目前支持 Pi，其他 agent 适配计划中。

### Pi

需要 [Pi](https://github.com/badlogic/pi-mono) 和 **Node.js >=24.18.0**，已在 **Pi SDK 1.0.0** 上测试。

从 npm 安装：

```sh
pi install npm:pi-compaction-recall
```

配置文件位于 Pi profile 的 agent 插件目录：`$PI_CODING_AGENT_DIR/extensions/compaction-recall.json`（默认：`~/.pi/agent/extensions/compaction-recall.json`）。**配置文件不会自动生成**，需要调整时手动创建；不创建则使用默认值或环境变量。

## 工具

`full` 模式会在回答前附上简短的历史定位提示，由模型决定是否继续搜索或展开。

| 工具 | 作用 |
|---|---|
| `history_recall` | 用概念组、替代词和排除词检索已压缩历史。 |
| `history_expand` | 按 ID 读取原始条目，可包含相邻条目并翻页。 |
| `history_grep` | 独立使用 JavaScript 正则表达式搜索历史。 |

## 配置

未填项用默认值，环境变量优先于配置文件，修改后重载。

| 配置项 | 默认值 | 说明 | 环境变量覆盖 |
|---|---|---|---|
| `mode` | `"full"` | `full` 提供自动提示和三个工具；`lite` 只保留 grep/expand。 | `COMPACTION_RECALL_MODE`（`full`/`lite`） |
| `jieba` | `true` | 按中文长词命中重排已有 FTS 候选，先排序再分页。 | `COMPACTION_RECALL_JIEBA`（`on`/`off`） |
| `autoGate` | `280` | 用户消息超过此长度时，按长任务指示处理，跳过自动召回以避免带入无关历史；模型仍可主动调用工具查询（汉字计 2，其余码点计 1）。 | `COMPACTION_RECALL_AUTO_GATE` |
| `snippetBudget` | `240` | 控制自动提示和 `history_recall` 每条结果展示的原文片段长度，越大允许展示的片段越长（汉字计 2，其余码点计 1）。 | `COMPACTION_RECALL_SNIPPET_BUDGET` |
| `recallTimeoutMs` | `5000` | 主动 recall 超时门槛，单位毫秒，不能抢占 native MATCH。 | `COMPACTION_RECALL_QUERY_TIMEOUT_MS` |
| `preindex.userCycles` | `10` | 完成多少轮用户交互后预热，范围 `1`–`100`，两个预热门槛满足任一即触发。 | `COMPACTION_RECALL_PREINDEX_TURNS` |
| `preindex.toolRounds` | `10` | 完成多少批工具调用后预热，范围 `1`–`100`，同批并行调用只计一次。 | `COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS` |
| `trace` | `false` | 记录带内容的 recall 诊断，需同时指定计时文件，日志应私密保存。 | 仅文件配置 |
| `COMPACTION_RECALL_TIMING_FILE` | 未设置 | JSONL 计时日志路径，不设则不记录计时。 | 仅环境变量 |


检索、预热和 trace 配置只对 `full` 模式生效。细节见 [配置与行为参考](https://github.com/shttty/compaction-recall/blob/main/doc/PLUGIN.zh-CN.md)。

## 范围与隐私

- 只搜索**当前分支**的已压缩历史，不跨会话或被放弃的分支。
- 索引用户/助手正文及助手工具调用名和参数，不索引思考内容、图片、工具结果正文或压缩摘要；可读的工具结果仍可按 ID 展开。
- 遵循分支内的上下文编辑：省略的条目不可见，替换内容会遮住原文。
- 提示和工具结果会进入模型上下文，可能发送给模型服务商；`lite` 只关闭自动提示，不阻止主动检索的历史被发送。

查不到不代表从未提到，重要信息应展开原文核实。诊断 trace 可能包含对话内容，不应公开上传。

## 评测

评测使用 [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) 的部分题目，以及基于 [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) 代码会话构造的回忆题。仓库包含 16 道中文题面译文、来源标识、处理说明、结果指标和复现脚本；原始语料及其他完整评测输入需另行获取。

答题模型：`gpt-6-luna`（high）；判题模型：`gpt-6-luna`（xhigh）。表中为答对题数 / 总题数，DEV8 和 HARD8 各 8 题。

### 历史最佳

| 模式 | DEV8 | HARD8 | 峰值合计 |
|---|---:|---:|---:|
| Pi 原生 | 2/8 | 0/8 | 2/16 |
| lite | 2/8 | 0/8 | 2/16 |
| full | 8/8 | 3/8 | 11/16 |

### 随机测试

2026-10-06 在固定英文 LongMemEval_M 题集上单轮实测，非重新随机抽题，也未从多轮结果中择优。三组使用相同题目、参考答案和原生 Pi 压缩快照；原生基线仅使用压缩后保留的上下文，不提供历史检索工具。

| 模式 | DEV8 | HARD8 | 合计 |
|---|---:|---:|---:|
| Pi 原生 | 0/8 | 0/8 | 0/16 |
| lite | 2/8 | 0/8 | 2/16 |
| full | 7/8 | 3/8 | 10/16 |

这是小规模开发集成绩，不代表完整 LongMemEval 跑分或稳定召回准确率。

运行命令和输入要求见 [benchmark 指南](https://github.com/shttty/compaction-recall/blob/main/doc/benchmark.zh-CN.md)。

## 开发

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

测试使用合成数据与隔离的 agent 目录。真实评测需要外部数据和模型服务配置，可能产生模型 API 费用。

## 许可

[MIT](https://github.com/shttty/compaction-recall/blob/main/LICENSE)。第三方软件与数据集的归属说明见 [第三方声明](https://github.com/shttty/compaction-recall/blob/main/THIRD_PARTY_NOTICES.zh-CN.md)。
