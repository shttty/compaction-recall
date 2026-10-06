# 第三方声明

[English](THIRD_PARTY_NOTICES.md) | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

compaction-recall 自身代码使用 [MIT 许可证](LICENSE)，Copyright (c) 2026 shttty。
下列第三方代码和评测材料保留各自的许可证与署名。

## @node-rs/jieba

- 用途：中文分词，用于检索排序；只在原生 worker 中加载。
- 版本：`@node-rs/jieba` 2.0.3。
- 来源：[napi-rs/node-rs](https://github.com/napi-rs/node-rs)。
- 许可：MIT，Copyright (c) 2020-present LongYinan。安装包附有自身的 LICENSE。

SQLite 由 Node 内置的 `node:sqlite` 提供。项目许可证不替代随 Node 或已安装依赖分发的声明。

## LongMemEval

- 用途：评测数据及答题、判分提示词。归档评测使用原始 LongMemEval_M。
- 来源：[数据集](https://huggingface.co/datasets/xiaowu0162/longmemeval)及[上游项目](https://github.com/xiaowu0162/LongMemEval)。
- 许可：上游软件使用 [MIT，Copyright (c) 2024 Di Wu](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE)；数据集发布者另外将原始数据集标为 MIT。

仓库保留 16 道冻结中文题面译文及评测元数据，完整数据集需另行获取。
插件运行时不下载或依赖 LongMemEval，评测材料不进入 npm 包。原始 MIT 声明附在本文末尾。

## SWE-chat

- 用途：从会话数据派生回忆题，用于评测。
- 来源：[SALT-NLP/SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat)。
- 许可：[Open Data Commons Attribution License (ODC-By) v1.0](https://opendatacommons.org/licenses/by/1-0/)。

本项目包含来自 SWE-chat 的信息。署名：Baumann, Padmakumar, Li, Yang, Yang and Koyejo,
*SWE-chat: Real-World AI Coding Sessions in the Wild*, COLM 2026,
<https://arxiv.org/abs/2604.20779v2>。

ODC-By 适用于数据库权利，不代表每份会话正文都适用同一许可证。
本仓库不分发 SWE 题目、答卷或会话摘录；所需数据应按上游适用的许可证获取。

评测输入与归档细节见[评测运行指南](https://github.com/shttty/pi-context-recall/blob/main/doc/benchmark.zh-CN.md)。

## LongMemEval MIT 声明原文

下方逐字保留英文许可证；中文说明不替代其法律正文。

```text
MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
