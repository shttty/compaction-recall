# Benchmark 与复现

唯一维护入口索引：[benchmark/INDEX.md](../benchmark/INDEX.md)。LME16/SWE-chat8当前runner、SDK/RPC、报告/判分与离线回归测试均归属本发布树，不依赖codingbench或其它兄弟worktree。

公开来源、处理、固定输入hash、七轮96个case的非正文机器指标和人工复核分离见[release provenance](../benchmark/data/release-0.1.0/INDEX.md)。按用户授权保留16道冻结中文题面；英文原题、参考/gold正文、最终回答、裁判理由、摘录和全文历史留外部。LME原题可按上游ID提取，中文翻译历史、修订参考、SWE派生题集及逐字输出需匹配hash的外部资产。

旧JS、S6策略、MiniSearch、索引替代实验、旧设计/提示和历史性能报告归[archive/](../archive/INDEX.md)。保留可追溯性，不机械合入生产算法；公开投影没有重新判分或重测。小样本冻结分数不是稳定准确率，也不能把历史内存/耗时重标成当前版本。

所有真实评测使用显式外部data/config/out与另行授权；配置不读取个人profile或兄弟工作树默认路径。维护中的SDK/worker smoke调用`src/index.ts`，验证已接受的部分token丢失警告、零token错误、worker恢复、grep→expand和自动提示，不要求旧原型的TOKENIZATION_LOSS行为。

`npm run check`与Python离线检查命令保持不变；npm allowlist保持production src、双语README、许可证及clean aggregate，benchmark/test/archive/session/profile/controller不打包。
