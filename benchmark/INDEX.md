# Benchmark 源码目录

运行步骤统一见 [如何运行 benchmark](../doc/benchmark.md)。本页索引当前实现，不维护第二套操作教程。

| 路径 | 当前职责 |
|---|---|
| `run.py` | 唯一 LME16 / SWE-chat CLI：解析输入、选择执行路径、汇总退出状态。 |
| `runner/execution.py`、`runner/cases.py` | arm/pilot/并发/报告编排，以及逐题答题/strict流水线和完成凭证恢复校验。 |
| `runner/resources.py`、`runner/sdk.py` | 单一资源/并发/容量停止/账本状态，以及冻结SDK命令、工具序列化与context估算。 |
| `runner/prepare.py`、`runner/artifacts.py`、`runner/phases.py` | 唯一输入/完整执行闭包/候选冻结、公共IO/hash/持久化及真实答题/strict阶段。 |
| `report.py` | 从当前已有结果生成离线报告；失败和缺项不记为0，覆盖分母明确。 |
| `smoke.mjs` | 网络阻断的真实SDK/worker检查，正式0/2/3工具及仅full自动提示。 |
| `sdk/` | 实际Pi SDK session、answer/judge桥接、RPC观察、context估算和工具/context证据；不实现另一套provider transport。 |
| `judging/`、`runner/answer_prompt.py` | strict与独立1–10判分契约/执行、原答题指示；不保留旧压缩/双语多轮CLI。 |
| [data/release-0.1.0/](data/release-0.1.0/INDEX.md) | 不可变历史来源、指标、原文件hash及授权中文题面。 |
| `data/lme16-current-three-arms-20261006.json` | 已验收当前版本三arm的非正文结果。 |
| `grep-only-adapter.mjs` | 仓库规则要求逐字保留的冻结证据；不属于当前lite，当前CLI不加载。 |

生产检索只在 `src/`：`tools/` 各自拥有 recall/grep/expand 的描述、schema和执行；`extension/` 管配置快照、索引生命周期/预热、自动context及共享分支/计时操作；`history/`、`search/`、`worker/`、`observability/` 保留各自职责。`src/index.ts`与替代入口`src/recall-extension.ts`均保持薄入口。离线测试按 `test/production/{tools,runtime,configuration}/`、`test/benchmark/{runner,sdk}/` 和共享 `test/fixtures/` 归组；Node仅递归收集 `test/**/*.test.mjs`，Python继续使用根索引给出的discovery命令，fixture与 `__init__.py` 不计测试。旧实验实现留在原有 `archive/` 和基线Git历史。历史资料中的命令和源码路径对应记录时提交，不是当前CLI契约；结构拆分不批量重写历史引用。

完整语料、reference、snapshot、答案、裁判正文及凭据由调用者在仓库外提供；当前runner自行生成候选/依赖/输入身份，不要求历史中文preflight或手工拼多份manifest。benchmark与测试不进入npm包。
