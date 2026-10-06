# Benchmark 源码目录

运行步骤统一见 [如何运行 benchmark](../doc/benchmark.md)。本页索引当前实现，不维护第二套操作教程。

| 路径 | 当前职责 |
|---|---|
| `coding-recall/e2e/lme-zh-run.py` | 唯一 LME16 / SWE-chat CLI：准备冻结、顺序三arm、真实SDK、持久化答题/判分、报告和恢复。 |
| `coding-recall/e2e/run.py` | 当前共用IO、hash、RPC/session及持久化支持；没有旧coding/OMP评测CLI。 |
| `coding-recall/e2e/*report.py` | 从当前已有结果生成离线报告；失败和缺项不记为0。 |
| `coding-recall/e2e/lme-zh-smoke.mjs` | 网络阻断的真实SDK/worker检查，正式0/2/3工具及仅full自动提示。 |
| `sdk-rpc.mjs`、`pi-rpc-observer.py` | 隔离profile的真实Pi SDK及RPC观察，不实现另一套provider transport。 |
| `lme-helper.py`、`retrieval-score-answers.py` | 当前答案指示与1–10判分契约；不再保留旧压缩/双语多轮判分CLI。 |
| [data/release-0.1.0/](data/release-0.1.0/INDEX.md) | 不可变历史来源、指标、原文件hash及授权中文题面。 |
| `data/lme16-current-three-arms-20261006.json` | 已验收当前版本三arm的非正文结果。 |
| `grep-only-adapter.mjs` | 仓库规则要求逐字保留的冻结证据；不属于当前lite，当前CLI不加载。 |

生产检索只在 `src/`。旧实验实现留在原有 `archive/` 和基线Git历史，不把本次删除代码重新搬入archive。旧Pi/OMP多轮、历史rawfts/concepts/fallback arm、模拟blind/retrieval平行框架及专属测试已退役。历史资料中的命令和源码路径对应记录时提交，不是当前CLI契约。

完整语料、reference、snapshot、答案、裁判正文及凭据由调用者在仓库外提供；当前runner自行生成候选/依赖/输入身份，不要求历史中文preflight或手工拼多份manifest。benchmark与测试不进入npm包。
