# Benchmark 脚本与结果索引

[benchmark/](../benchmark/) 包含可执行脚本、专用辅助、实验实现和冻结结果。生产代码在 `src/`，测试在 `test/`，所有使用说明在 `doc/`。下列真实结果小样本且单轮，仅作描述性记录；目录/配置重构没有重跑模型或提高成绩。

## 当前入口

| 用途 | 入口 | 输入与约束 |
| --- | --- | --- |
| Pi / LongMemEval 评测 | [evaluate.py](../benchmark/evaluate.py)、[配置与协议](EVALUATION.md) | 每次显式 `--config`；compression/answer/judge 都无 provider/model/effort 默认值。SDK、官方 helper、数据、profile、输出和候选仓库均由外部指定 |
| 单题词面扫描 / 索引 | [benchmark.mjs](../benchmark/benchmark.mjs) | `--input QUESTION_JSON --output NEW_RESULT_JSON` |
| 十历史堆叠 | [prepare-stacked.py](../benchmark/prepare-stacked.py)、[stacked-benchmark.mjs](../benchmark/stacked-benchmark.mjs) | 准备：`--source DATA_JSON --output QUESTIONS_JSON`；测量：`--input QUESTIONS_JSON --output NEW_RESULT_JSON [--pilot]` |
| worker / 计时 | [benchmark-background.mjs](../benchmark/benchmark-background.mjs)、[timing-smoke.mjs](../benchmark/timing-smoke.mjs) | `--source SESSION_JSONL --query TEXT --output NEW_RESULT_JSON`；需要外部 session，不能拿归档里的 hash 当 session |
| 盲测工具模拟 | [blind-harness.mjs](../benchmark/blind-harness.mjs)、[solver 协议](BLIND_PROTOCOL.md) | 显式 `--data CORPUS_JSON --runs EXTERNAL_RUNS`；只复用真实工具，不等价于真实 Pi/provider 运行 |
| 无模型候选提取 | [prepare-rerank.mjs](../benchmark/prepare-rerank.mjs) | `--data QUESTIONS_JSON --candidates NEW_PRIVATE_JSON --results NEW_RETRIEVAL_JSON`；含正文窗口的 candidates 留外部 |
| 外部重排结果汇总 | [summarize-rerank.mjs](../benchmark/summarize-rerank.mjs) | `--config SUMMARY_CONFIG_JSON`；见 [重排说明](RERANK.md)。读取用户指定结果，不注册、下载或运行固定模型 |
| 其他汇总与数据辅助 | [summarize-stacked.mjs](../benchmark/summarize-stacked.mjs)、[extract-question.py](../benchmark/extract-question.py)、[verify-dataset.py](../benchmark/verify-dataset.py) | 所有路径显式传入；下载器需另行授权。`--help` 只显示接口，不下载或评测 |

源码已整块移除固定 CLP/Luna/Sol 注册、默认档位、私有路径、个人 profile 复制/链接与交互凭据写入器。旧 Pi0.99.1/TUI/固定 checkpoint 恢复和绑定固定模型的本地推理/下载脚本不作为公共入口保留；方法和负面结果仍在下文。没有旧名称 shim 或隐藏兼容实现。

## 离线检查

```sh
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
python3 benchmark/evaluate.py --help
python3 benchmark/evaluate.py pin --help
python3 benchmark/evaluate.py run --help
```

测试使用临时明确标注的合成 helper/config/profile/model/snapshot，不需要个人配置、兄弟目录或历史 Git 对象。`test/check-extensions.mjs` 是带参数脚本，不是无参数 `node --test` 套件：

```sh
node test/check-extensions.mjs "$WRAPPER" "$ARCHIVE_A" "$ARCHIVE_B"
```

这三个变量必须指向已有只读 wrapper 和两份不可变 archive。脚本依据 manifest.entry 检查历史根入口或 `src/` 入口。npm suite 另行真实隔离加载当前 package、`src/index.ts`、`src/recall-extension.ts`。这些离线检查不代表真实模型跑分。

## 已归档真实 CLP 结果

位置：[results/recall-20261002/](../benchmark/results/recall-20261002)。三组顺序固定为 **native / grep / production**。以下统一 Pi SDK **1.0.0**，压缩 **clp/gpt-6-luna high**、judge **clp/gpt-6-luna xhigh**。每行 8 道独立原始 LongMemEval_M 历史，每组每题一次；不同候选行是不同答题轮次。表中只引用既有审计正确数，不重判答案。

| 集合 / 正式组 | 答题模型 / effort | 插件代号 | 正确数（各 /8） | 最终审计 |
| --- | --- | --- | --- | --- |
| DEV8 capacity-base | Luna / high | A | 0 / 5 / 7 | [audit](../benchmark/results/recall-20261002/audits/parent-dev8-capacity-base-audit.json) |
| DEV8 capacity-paging | Luna / high | B | 0 / 6 / 8 | [audit](../benchmark/results/recall-20261002/audits/parent-dev8-capacity-paging-audit.json) |
| DEV8 coverage | Luna / high | C | 0 / 4 / 7 | [audit](../benchmark/results/recall-20261002/audits/parent-dev8-coverage-audit.json) |
| DEV8 grep-pages | Luna / high | D | 0 / 3 / 8 | [audit](../benchmark/results/recall-20261002/audits/parent-dev8-grep-pages-audit.json) |
| HARD8 base | Luna / high | A | 1 / 1 / 3 | [audit](../benchmark/results/recall-20261002/audits/parent-hard8-base-audit.json) |
| HARD8 paging | Luna / high | B | 0 / 1 / 2 | [audit](../benchmark/results/recall-20261002/audits/parent-hard8-paging-audit.json) |
| HARD8 grep-pages | Luna / high | D | 0 / 1 / 3 | [audit](../benchmark/results/recall-20261002/audits/parent-hard8-grep-pages-audit.json) |
| HARD8 sol-high-d4259198 | **gpt-6.1-sol / high** | D | 1 / 6 / 6 | [audit](../benchmark/results/recall-20261002/audits/parent-hard8-sol-high-audit.json) |

Luna 指 `clp/gpt-6-luna`；Sol 指 `clp/gpt-6.1-sol`。插件完整 commit：

- A：`f5715d1901b6bedf19811030f18f3733eefb7bc4`
- B：`7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014`
- C：`5acf40efa9cb33146d3e9526fc411a769511cee8`
- D：`8149e1f6caece71de148c92a88790e5d35212d9e`

冻结比较报告：

- [DEV8 capacity](../benchmark/results/recall-20261002/reports/dev8-capacity-comparison.md)：A / B。
- [DEV8 final](../benchmark/results/recall-20261002/reports/dev8-final-comparison.md)：含 C，对比前两组。
- [DEV8 grep-pages](../benchmark/results/recall-20261002/reports/dev8-grep-pages-comparison.md)：D；[当时的完整接收记录](../benchmark/results/recall-20261002/reports/dev8-grep-pages-full-accepted.md)。
- [HARD8 final](../benchmark/results/recall-20261002/reports/hard8-final-comparison.md)：A / B，保留 paging 低于 base 的观测。
- [HARD8 grep-pages](../benchmark/results/recall-20261002/reports/hard8-grep-pages-comparison.md) 与 [JSON](../benchmark/results/recall-20261002/reports/hard8-grep-pages-comparison.json)：D。
- [HARD8 Sol/high](../benchmark/results/recall-20261002/reports/hard8-sol-high-comparison.md)：正式修复后 `d4259198` runner，不是错模型 pilot。

**容量失败负面结果也保留。** [dev8-base-ed09d12 审计](../benchmark/results/recall-20261002/audits/dev8-base-ed09d12-audit.json)：Luna/high、SDK 1.0.0、插件 A；8 题中 6 题完成，另 2 题 preflight compression-error。按原 8 题分母为 0/8、4/8、6/8；不能称为完整干净 DEV8。失败不改写为模型判错。

[runs/](../benchmark/results/recall-20261002/runs) 原样保留 72 个逐题 run 的 `manifest.json`、`results.jsonl` 与 210 份每 arm 最终 `judge.json`。其中 8 个正式组共 192 条 graded records，容量失败组 18 条加 2 条 compression-error。`judge.json` 内嵌最终答案与 grade，不是 SDK session；同一结果在 audit / ledger / judge 出现多次，不能重复计数。逐组 run 路径、题号与 runner 哈希见 [PROVENANCE.json](../benchmark/PROVENANCE.json)。

所有独立 pilot 均未归档；尤其 `hard8-sol-high-2ea9b1c9` 实际错用 Luna，**不计入 Sol 分数**，也不替换正式 run。原 pilot、原始数据、快照、sessions、launchers 全留外部，未删除或改写。

## 更早结果与测量

以下从原 `prototype/` 移入，结果 JSON 字节保持不变。报告中的源码哈希和旧路径描述当时版本，不等于当前迁移后 runner；未记录的 commit 不补造。

| 类型 | 报告与结果 | 归属 / 限制 |
| --- | --- | --- |
| 单题索引、十历史堆叠 | [INDEX_EXPERIMENT.md](INDEX_EXPERIMENT.md)、[results.json](../benchmark/results.json)、[STACKED.md](STACKED.md)、[stacked-summary.json](../benchmark/stacked-summary.json) | 词面性能/证据覆盖，不调用答题模型；早期代码版本见原报告与 provenance |
| 后台索引与计时 smoke | [后台设计](BACKGROUND_INDEX.md)、[background-results.json](../benchmark/background-results.json)、[timing-smoke-results.json](../benchmark/timing-smoke-results.json) | 历史本地性能测量，不是本次 smoke 或模型成绩 |
| 重排 | [RERANK.md](RERANK.md)、[rerank-summary.json](../benchmark/rerank-summary.json)、[模型 manifest](../benchmark/rerank-model-manifest.json) | mMiniLMv2 / Qwen3 检索重排，不是 CLP 答题成绩 |
| Pi DEV8 初次 | [PI_DEV8.md](PI_DEV8.md)、[pi-dev8-results.json](../benchmark/pi-dev8-results.json) | `openai-codex/gpt-6-luna high`、Pi 0.99.1，同步索引实验组；无独立 judge，人工式事后参考核对 |
| Pi DEV8 逐阶段 | [PI_DEV8_TIMED.md](PI_DEV8_TIMED.md)、[pi-dev8-timed-results.json](../benchmark/pi-dev8-timed-results.json)、[参考核对](../benchmark/pi-dev8-timed-evaluation.json) | 同模型 / SDK，后台索引实验组，记录 0/8、6/8、8/8；不是 SDK 1.0.0 production arm。失败重试保留 |
| 单题 TUI 暖会话 | [PI_TUI_WARM.md](PI_TUI_WARM.md)、[pi-tui-warm-results.json](../benchmark/pi-tui-warm-results.json) | DEV8 `577d4d32`、历史 Pi 0.99.1 / Luna high；交互演示，不是新八题评测 |

## Provenance 与迁移边界

[PROVENANCE.json](../benchmark/PROVENANCE.json) 是冻结的既有结果导入清单，记录原始 source/destination/SHA256 和上次 old/new 映射；里面的旧 runner 路径/源码 hash 属于当时归置，不是现行接口。当前说明索引使用相对链接。原报告的历史路径、模型名、effort、commit 和统计不改写；不把它们变成当前默认配置。

新 runner 的配置、源码和 snapshot 指纹不同，不能恢复/冒充旧 run，不能给旧 cache 重贴标签。原始结果及外部 run/cache/profile 均保留。仓内没有真实 snapshot/session、个人认证配置、模型权重或完整语料；输出与认证始终置于明确指定的外部目录。
