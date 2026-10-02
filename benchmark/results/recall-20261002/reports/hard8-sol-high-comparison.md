# HARD8：Sol high 与 Luna high（同插件、同快照）

正式 Sol run prefix：`hard8-sol-high-d4259198`。不是 xhigh 测试。
插件：`8149e1f6caece71de148c92a88790e5d35212d9e`。SDK 1.0.0；判分 Luna xhigh。八题沿用相同快照。
Runner SHA-256：`d4259198e3290ffca46a3aa9245a74213aa076e8867b7079e8d70f96b6af3b55`。

| 组别 | Luna high 正确 | Sol high 正确 | Luna 平均答题秒 | Sol 平均答题秒 |
|---|---:|---:|---:|---:|
| 原生，无检索工具 | 0/8 | 1/8 | 17.7 | 28.2 |
| 仅 grep/expand | 1/8 | 6/8 | 27.0 | 70.8 |
| 完整插件 | 3/8 | 6/8 | 94.7 | 97.8 |

## 用量（仅答题，cache 计入总量，不等于账单）

| 组别 | Luna model calls / tool calls | Sol model calls / tool calls | Luna 总 token 含 cache | Sol 总 token 含 cache |
|---|---:|---:|---:|---:|
| 原生，无检索工具 | 8 / 0 | 8 / 0 | 2,237,591 | 2,238,774 |
| 仅 grep/expand | 15 / 7 | 42 / 42 | 4,239,009 | 12,056,331 |
| 完整插件 | 57 / 74 | 58 / 83 | 16,443,912 | 16,888,260 |

## 观察

- 这轮 Sol 完整插件多答对三题：`gpt4_15e38248`、`6d550036`、`gpt4_731e37d7`；同插件 Luna 已答对的题无倒退。
- Sol grep 与完整插件总分均为 6/8，但不是同六题：grep 解出 `gpt4_7fce9456`，完整插件解出 `2ce6a0f2`。完整插件本轮未提高总分，工具调用更多；不据此宣称自动召回无用。
- 完整插件错题：`gpt4_7fce9456`，标准 4 个房产、答 5（明确纳入目标 townhouse）；`28dc39ac`，标准 140 小时、答 155–160 小时（纳入额外场次/范围）。这是答案与 gold 的差异，不是已验证的完整错误因果链。

## 验证与边界

- 24/24 答题、判分及实际 SDK 会话记录核对通过；模型是 gpt-6.1-sol，会话 reasoning level high，实际隔离模型配置一致。
- 逐题三组 snapshot 前缀字节一致，所有快照复用；原有数据/结果保持不变。
- Guarded identical resume 新增 provider/model 调用 0。
- 旧错模型 pilot 的 3 条记录保留并排除，额外诊断答题调用 11，不混入本表。
- 仅八题、单轮描述性对比，不证明稳定准确率提升。两种答题模型配置不同：Sol 配置输出上限 8192、Luna 128000；不能独立归因模型、配置或服务端行为。
- 时间是含工具轮次的答题 wall time，不是 provider TTFT。账单未知；压缩/判分及无效诊断 pilot 的 token 不含在上表。

## 审计文件

- `/home/rinne/.hermes/task-runs/recall-20261002/parent-hard8-sol-high-audit.json` SHA-256 `052d61e3a2571783f0ed4dde55213039efae51ff2e6981d4b75f9fb9a6d10145`
- `/home/rinne/.hermes/task-runs/recall-20261002/parent-hard8-grep-pages-audit.json` SHA-256 `153b90b1a2be8f255397ddd2097a43192abf749763ca6869c650ca438e814a4f`
