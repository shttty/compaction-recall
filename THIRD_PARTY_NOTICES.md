# Third-party notices

[English](https://github.com/shttty/compaction-recall/blob/main/THIRD_PARTY_NOTICES.md) | [简体中文](https://github.com/shttty/compaction-recall/blob/main/THIRD_PARTY_NOTICES.zh-CN.md)

compaction-recall's own code is licensed under the [MIT License](https://github.com/shttty/compaction-recall/blob/main/LICENSE),
Copyright (c) 2026 shttty. The third-party code and evaluation materials below
retain their respective licenses and attribution.

## @node-rs/jieba

- Use: Chinese word segmentation for retrieval ranking, loaded only in the native worker.
- Version: `@node-rs/jieba` 2.0.3.
- Source: [napi-rs/node-rs](https://github.com/napi-rs/node-rs).
- License: MIT, Copyright (c) 2020-present LongYinan. The installed package includes its LICENSE.

SQLite comes from Node's built-in `node:sqlite`. The project's license does not
replace notices supplied with Node or installed dependencies.

## LongMemEval

- Use: evaluation data and answer/judge prompts. The archived evaluations use the original LongMemEval_M.
- Sources: [dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval) and [upstream project](https://github.com/xiaowu0162/LongMemEval).
- License: the upstream software uses [MIT, Copyright (c) 2024 Di Wu](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE). The dataset publisher separately labels the original dataset MIT.

The repository includes 16 frozen Chinese question translations and evaluation
metadata. Full datasets are obtained separately; the plugin does not download
or depend on LongMemEval at runtime. Evaluation materials are excluded from npm.
The original MIT notice is reproduced below.

## SWE-chat

- Use: conversation data from which recall questions were derived for evaluation.
- Source: [SALT-NLP/SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat).
- License: [Open Data Commons Attribution License (ODC-By) v1.0](https://opendatacommons.org/licenses/by/1-0/).

This project contains information from SWE-chat. Attribution: Baumann, Padmakumar,
Li, Yang, Yang and Koyejo, *SWE-chat: Real-World AI Coding Sessions in the Wild*,
COLM 2026, <https://arxiv.org/abs/2604.20779v2>.

ODC-By covers database rights; it does not establish a license for every
transcript's contents. This repository does not distribute SWE questions,
answers or transcript excerpts. Obtain data from the source under its applicable license.

For evaluation inputs and archive details, see the
[benchmark guide](https://github.com/shttty/compaction-recall/blob/main/doc/benchmark.md).

## LongMemEval MIT notice

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
