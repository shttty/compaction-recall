# Benchmark 源码目录

运行步骤统一见 [如何运行 benchmark](../doc/benchmark.md)。本页只索引代码和资料，不维护第二份操作教程。

| 路径 | 用途 |
|---|---|
| `coding-recall/e2e/lme-zh-run.py` | 固定 LME16 的 Pi 原生、lite、full 答题与判分入口。 |
| `coding-recall/e2e/lme-zh-smoke.mjs` | 阻断网络的 SDK / worker 接线检查。 |
| `coding-recall/e2e/run-swechat.py` | 基于外部 SWE-chat 派生题集的答题评测。 |
| `coding-recall/e2e/*report.py` | 从已有结果生成离线报告。 |
| `evaluate.py`、`lme-helper.py` | 输入提取、历史构造及评测支持；不替代三模式所需的完整冻结材料。 |
| `retrieval-group1.mjs`、`retrieval-group2.py` | 检索排序及模型查询行为评测。 |
| [methods/RETRIEVAL_CONTRACT.md](methods/RETRIEVAL_CONTRACT.md) | 检索评测的输入、接口和指标定义。 |
| [data/release-0.1.0/](data/release-0.1.0/INDEX.md) | 数据来源、处理说明、历史指标及授权保留的中文题面。 |

生产检索实现只在 `src/`。原型和历史实验保留在 `archive/`；完整语料、快照、答案、判分正文及凭据由调用者在仓库外提供，不能作为公开结果一并提交。benchmark 不包含在 npm 包中。
