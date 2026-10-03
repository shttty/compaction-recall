# compaction-recall

[English](README.md) | [简体中文](README.zh-CN.md)

When Pi compacts a long conversation, the summary keeps the gist and loses the names, numbers and exact wording. compaction-recall lets the model go back to the original messages that compaction removed and look those details up.

It doesn't replace Pi's own compaction, and adds no database, no files on disk and no extra model calls.

## Install

Requires Node.js 24+ and Pi SDK 1.0.0.

```sh
pi install git:github.com/shttty/pi-context-recall
```

(Temporary address until the repository is renamed.)

## Usage

It works once installed. After a compaction, the model gets a few likely-relevant old message locations before each answer, then decides for itself whether to look: `history_recall` searches by keyword, `history_expand` reads the original text, and `history_grep` runs a regex search.

If you don't want the automatic hints or the background index, switch to `lite`, which keeps only `history_grep` and `history_expand`:

```sh
COMPACTION_RECALL_MODE=lite pi
```

You can also set this in `~/.pi/agent/extensions/compaction-recall.json`. All options and tool details are in [doc/PLUGIN.md](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md).

## Evaluation

The questions come from the original LongMemEval_M split of [LongMemEval](https://github.com/xiaowu0162/LongMemEval). Every history runs past a million tokens, so each question has to go through real Pi compaction before it is answered.

| Set | Answer model | Pi alone | + `lite` | + `full` |
| --- | --- | --- | --- | --- |
| DEV8 | gpt-6-luna / high | 0 | 3 | 8 |
| HARD8 | gpt-6-luna / high | 0 | 1 | 3 |
| HARD8 | gpt-6.1-sol / high | 1 | 6 | 6 |

Each cell is correct answers out of 8, and all three columns use the same compacted snapshot. In DEV8 the evidence sits in a single compacted segment; in HARD8 it is spread across several, and the questions were picked for difficulty. A LongMemEval history is many simulated chats stitched together, and each one was fed into a single Pi session, so nothing here searches across Pi sessions.

These are archived single runs from development on small sets, using an older build from before the `lite`/`full` switch existed; they were not re-measured with the current code. Scores depend mostly on the answer model: with the same plugin and snapshots, Sol got 6 of the HARD8 questions and Luna got 3. Full records are in [doc/BENCHMARK_RESULTS.md](doc/BENCHMARK_RESULTS.md).

## Performance

Measured offline with no model calls: one LongMemEval_M history cut to several lengths, with everything except the last ~20k tokens compacted. Node.js 24.18 on a Ryzen 7 5800H; median of 3 fresh processes.

**Memory** (extra process RSS over the same session without the extension):

| History | `full` | `lite` |
| --- | --- | --- |
| 50k tokens | 23 MiB | 2 MiB |
| 200k tokens | 44 MiB | 2 MiB |
| 500k tokens | 66 MiB | 2 MiB |
| 1M tokens | 125 MiB | 3 MiB |

In `full`, memory grows with the compacted history, roughly 11 MiB per 100k tokens. `lite` keeps no index, so it adds almost nothing.

**Time** (`full`, milliseconds):

| History | Index build (background) | Longest main-thread pause | Added to each request | `history_recall` reply | First request during a rebuild |
| --- | --- | --- | --- | --- | --- |
| 50k tokens | 101 | 0.6 | 1 | 1 | 62 |
| 200k tokens | 197 | 0.7 | 4 | 8 | 159 |
| 500k tokens | 375 | 1.0 | 10 | 18 | 325 |
| 1M tokens | 665 | 1.0 | 19 | 36 | 606 |

The index is built in a worker thread, so the main thread barely pauses. "Added to each request" is the automatic hint lookup before every model call once the index is ready. If a request arrives while the index is still being rebuilt, it waits for it; that is the last column. In `lite`, nothing runs in the background, and a `history_grep` over 1M tokens takes about 8 ms. Full method and raw numbers are in [doc/PERFORMANCE.md](doc/PERFORMANCE.md).

## Limits

- It only searches what was compacted out of the current branch: not other sessions, and not the compaction summary itself.
- It uses keyword matching, not semantic search. No hit doesn't mean it was never said.
- Tool results and thinking are not searched.
- In `full`, the automatic hints are sent to your model provider with each request, and the index lives in memory, growing as the conversation gets longer.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

All tests run offline.

## License

MIT. LongMemEval attribution and license are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#longmemeval-evaluation-material).
