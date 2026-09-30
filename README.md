# pi-recall

Pi 原生压缩之后，用 `history_grep` / `history_expand` 回查当前分支被压掉的原文。独立的小扩展，不加载主插件 `src/`，不接管压缩，不新增 SQLite、FTS、向量索引、后台任务或模型调用。已验证宿主 SDK：0.85.1。

本仓库从 `pi-lossless-context/prototype/recall-spike` 独立提取。运行时代码保持原样，所有相对导入都在本仓库内，不依赖原项目。原项目目录和 benchmark 兼容入口保留在原处。`FINDINGS.md` 是历史实验结果，不是本次整理后重新跑分的结论。

## 加载

在仓库根目录临时加载，不改 profile：

```sh
pi -e ./index.ts
```

也可以将整个目录作为本地 Pi package 安装；这会修改用户的 Pi settings，需要你自己决定执行：

```sh
pi install /absolute/path/to/pi-recall
```

`package.json` 的 `pi.extensions` 指向 `index.ts`。本仓库也支持 `pi -e ./recall-extension.ts`。两个入口只选一个，避免重复注册。宿主提供 Pi SDK 和 `typebox`，不捆绑另一套 SDK；开发和测试使用本仓库 `package-lock.json` 锁定的依赖（Pi SDK 0.85.1）。本次没有安装到任何个人 profile，也没有发布包。

## 工具与范围

- `history_grep({ pattern })`：大小写不敏感的 JavaScript 正则；支持 `SF|San Francisco`。正则无效时按字面量搜索。按会话顺序返回 entry id、日期、角色及片段；最多 30 个片段，每条 entry 最多 3 个，仍统计全部匹配次数。空正则遵循 JavaScript 的零宽匹配语义。
- `history_expand({ id, before?, after? })`：按 grep 的 id 展开原文文本及前后消息；前后默认各 2 条，各可设 0–20。只允许当前已压缩段里的 id，不读当前上下文或其他分支。
- 每次调用从 `ctx.sessionManager.getBranch()` 重新取当前分支。以最新 compaction 的 `firstKeptEntryId` 为界，仅扫描该条目之前的 message；尚未压缩则返回空。如果边界 id 缺失，沿用 spike 行为：扫描最新 compaction 之前的消息。
- 读取消息字符串或内容中的 `text` 块，包括原会话中仍存在的工具输出文本；不包含 thinking、工具调用参数、图片或完整 JSON。工具输出不写进任何数据库或索引，也不另存副本；Pi 已经删掉或省略的内容无法恢复。
- 只查当前分支，不跨会话、不跨 `parentSession`、不搜索被放弃的分支，也不搜索 compaction 摘要。

## 文件

- `index.ts`：公开 Pi package 入口
- `recall-extension.ts`：两个工具的注册、结果格式；兼容 benchmark 旧入口
- `history.ts`：无副作用的条目文本、压缩边界及正则辅助函数
- `test/recall.test.mjs`：离线行为与独立目录加载测试

## 离线验证

需要 Node 24+（本次 Node 24.19.0）和 npm。在本仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run check
```

安装依赖需要网络或已有 npm 缓存；`typecheck` 和 `test` 离线运行，不调用模型。测试覆盖两个工具的原有行为，并通过 Pi SDK 从临时隔离目录加载 package、`index.ts` 和兼容入口。隔离目录只包含运行时文件和 manifest，不含 node_modules 或 Git 数据，测试后删除；不修改用户 profile。

## 来源与许可

提取自 `pi-lossless-context` 的工作区版本，基于提交 `62012df340d0774698ece6705062777b82d2f0e3`，包含当时尚未提交的 recall 整理。没有复制原仓库 Git 历史、会话、日志、凭据或数据库。

原项目未提供适用于自身代码的 LICENSE，本仓库未擅自指定开源许可证。`THIRD_PARTY_NOTICES.md` 保留原项目的 hermes-lcm 设计来源及其 MIT 声明；该声明不等于本仓库自身采用 MIT。公开发布或分发前应由维护者确认代码授权及本仓库许可证。

## 当前限制

这是对现有 recall spike 的整理，不改变它的检索算法或基准语义。每次扫描都是线性的；正则没有执行超时，避免高回溯的复杂表达式。结果按原文顺序，不按相关性排序，也不会自动触发回查。

展开输出沿用 16000 个 UTF-16 单元的头部截断，并附 `[truncated]`，还没有分页；可能切断代理对。很长的前文可能挤掉请求条目，先用 `before: 0, after: 0` 聚焦，但单条长文本尾部仍不可达。`details.from/to` 表示选中的消息范围，不保证截断后全部可见。grep 的匹配计数是完整计数，片段本身没有全局字符上限，特别长的正则匹配可能产生很大的片段。后续若修这些限制，应单独做行为变更与基准验证。
