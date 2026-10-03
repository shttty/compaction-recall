# compaction-recall

[English](README.md) | [简体中文](README.zh-CN.md)

Pi 压缩长对话之后，摘要只剩大意，名字、数字、原话都没了。compaction-recall 让模型回到被压缩掉的原始消息里，把这些细节查回来。

它不替换 Pi 自己的压缩，不加数据库，不写磁盘，也不额外调用模型。

## 安装

需要 Node.js 24+ 和 Pi SDK 1.0.0。

```sh
pi install git:github.com/shttty/pi-context-recall
```

（仓库改名前的临时地址。）

## 使用

装上就生效。对话被压缩后，模型每次回答前会收到几条可能相关的旧消息位置，然后自己决定要不要查：`history_recall` 按关键词找，`history_expand` 读原文，`history_grep` 做正则搜索。

不想要自动提示和后台索引，就切到 `lite`，只保留 `history_grep` 和 `history_expand`：

```sh
COMPACTION_RECALL_MODE=lite pi
```

也可以写进 `~/.pi/agent/extensions/compaction-recall.json`。全部配置和工具细节见 [doc/PLUGIN.md](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md)。

## 评测

题目来自 [LongMemEval](https://github.com/xiaowu0162/LongMemEval) 的原始 LongMemEval_M。每条历史都超过一百万 token，答题前必须先经过真实的 Pi 压缩。

| 题集 | 答题模型 | 只有 Pi | + `lite` | + `full` |
| --- | --- | --- | --- | --- |
| DEV8 | gpt-6-luna / high | 0 | 3 | 8 |
| HARD8 | gpt-6-luna / high | 0 | 1 | 3 |
| HARD8 | gpt-6.1-sol / high | 1 | 6 | 6 |

每格是 8 题里答对的数量，三列用的是同一份压缩快照。DEV8 的证据在单个被压缩段里；HARD8 的证据分散在多个段里，题目按难度挑选。LongMemEval 的历史由许多段模拟聊天拼成，评测时整条喂进同一个 Pi session，所以这里没有跨 Pi session 的检索。

这是开发期间归档的单轮结果，题目少，用的是还没有 `lite`/`full` 开关的旧版本，没有用当前代码重测。分数主要取决于答题模型：插件和快照都一样，HARD8 上 Sol 答对 6 题，Luna 只答对 3 题。完整记录见 [doc/BENCHMARK_RESULTS.md](doc/BENCHMARK_RESULTS.md)。

## 性能

离线测量，不调用模型：把一条 LongMemEval_M 历史截成几种长度，除最后约 2 万 token 外全部压缩。Node.js 24.18，Ryzen 7 5800H；每格取 3 个全新进程的中位数。

**内存**（相对同一 session 不加载插件时，多出来的进程 RSS）：

| 历史长度 | `full` | `lite` |
| --- | --- | --- |
| 5 万 token | 23 MiB | 2 MiB |
| 20 万 token | 44 MiB | 2 MiB |
| 50 万 token | 66 MiB | 2 MiB |
| 100 万 token | 125 MiB | 3 MiB |

`full` 的内存随被压缩的历史增长，大约每 10 万 token 增加 11 MiB。`lite` 不建索引，几乎不增加内存。

**时间**（`full`，单位毫秒）：

| 历史长度 | 建索引（后台） | 主线程最长停顿 | 每次请求多花 | `history_recall` 返回 | 重建期间的首次请求 |
| --- | --- | --- | --- | --- | --- |
| 5 万 token | 101 | 0.6 | 1 | 1 | 62 |
| 20 万 token | 197 | 0.7 | 4 | 8 | 159 |
| 50 万 token | 375 | 1.0 | 10 | 18 | 325 |
| 100 万 token | 665 | 1.0 | 19 | 36 | 606 |

索引由 worker 线程建，主线程几乎不停顿。"每次请求多花"是索引就绪后，每次调用模型前查自动提示的时间。如果请求赶上索引正在重建，就要等它建完，即最后一列。`lite` 没有任何后台工作，在 100 万 token 上跑一次 `history_grep` 大约 8 ms。完整方法和原始数据见 [doc/PERFORMANCE.md](doc/PERFORMANCE.md)。

## 限制

- 只能查当前分支里被压缩掉的内容，查不到其他 session，也查不到压缩摘要本身。
- 用的是关键词匹配，不是语义检索。查不到不代表没说过。
- 工具结果和 thinking 不在搜索范围内。
- `full` 的自动提示会随请求发给模型服务；它的索引放在内存里，对话越长占得越多。

## 开发

```sh
npm ci --ignore-scripts
npm run check
```

测试全部离线运行。

## 许可

MIT。LongMemEval 的来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#longmemeval-evaluation-material)。
