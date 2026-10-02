# 实验实现

[benchmark/experimental/](../benchmark/experimental/) 保留未接入生产的索引实现：`inverted-index.mjs`、`background-index.mjs`、`index-worker.mjs`，以及预索引调度 `preindex-cadence.mjs`、配置读取 `preindex-config.mjs` 和无认证信息的节奏配置示例 `pi-recall.config.example.json`。

`corpus.mjs` 是统一离线测试使用的合成语料；`stage-timing.mjs` 是 worker 和 benchmark 适配器共用的阶段计时依赖，不是独立跑分入口。[BACKGROUND_INDEX.md](BACKGROUND_INDEX.md) 保留实验设计与边界说明。生产入口仍使用扫描，不导入这些实验索引。

脚本与历史结果见 [BENCHMARK.md](BENCHMARK.md)，原索引对比见 [INDEX_EXPERIMENT.md](INDEX_EXPERIMENT.md)。所有可执行离线测试都在 `test/`；没有根 prototype 或旧路径 shim。
