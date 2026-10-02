# 实验实现与生产切换

worker 倒排索引、预分词节奏和配置已迁入 `src/`，由公开 `src/index.ts` → `src/recall-extension.ts` 使用。原 `benchmark/experimental/` 中的 `background-index.mjs`、`index-worker.mjs`、`inverted-index.mjs`、`preindex-cadence.mjs`、`preindex-config.mjs` 和 `stage-timing.mjs` 已删除，不保留副本或 shim。共享的历史、词法 / 渲染与计时实现分别为 `src/history.mjs`、`src/locator.mjs` 和 `src/timing.mjs`，主线程与 worker 直接复用；对应 `.ts` 实现已移除，worker 不再触发运行时 TypeScript 转译或实验特性警告。生产运行时仍不得导入实验目录.

合成语料在 `test/corpus.mjs`；所有离线测试仍在 `test/`。生产配置由 `src/recall-config.mjs` 从 `<getAgentDir()>/extensions/compaction-recall.json` 读取，mode 与预分词在扩展加载时统一固定。完整配置示例（含 mode / preindex）直接写在 [PLUGIN.md](PLUGIN.md)，原实验配置示例和空实验目录已删除，不保留配置读取兼容层。`benchmark/pi-benchmark-adapter.mjs` 的 indexed arm 直接注册生产扩展，grep arm 抑制全部索引生命周期 / context hook；计时事件、同步索引 smoke 和其他离线适配器引用 `src/`。

当前生命周期、预分词隔离和加载边界见 [BACKGROUND_INDEX.md](BACKGROUND_INDEX.md)，默认关闭的生产计时见 [TIMING.md](TIMING.md)。脚本与冻结结果见 [BENCHMARK.md](BENCHMARK.md)，原同步索引对比见 [INDEX_EXPERIMENT.md](INDEX_EXPERIMENT.md)。本次迁移不重跑评测、不修改结果 / manifest / provenance，也不把历史测量重新标为当前生产实现的结果。
