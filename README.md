# pi-context-recall

[English](README.md) | [简体中文](README.zh-CN.md)

When Pi compacts a long conversation, the summary keeps the gist and drops the details: a name, a number, the exact thing you said three hours ago.
**pi-context-recall** lets the model look those details up again in the original messages that compaction moved out of context.

It sits on top of Pi's native compaction. It does not replace it, and adds no database, files on disk or extra model call.

## Install

Requires **Node.js 24+** and Pi (verified against Pi SDK **1.0.0**).

```sh
pi install git:github.com/shttty/pi-context-recall
```

To try it once from a source checkout without changing your settings:

```sh
pi -e ./src/index.ts
```

Load only one copy of the extension.

## Modes

| | `full` (default) | `lite` |
| --- | --- | --- |
| Tools | `history_recall`, `history_grep`, `history_expand` | `history_grep`, `history_expand` |
| Automatic hint | Yes | No |
| Background indexing | One worker thread per session | None |

`lite` only gives the model the search tools; it decides on its own when to look. It sends no hidden hint, though tool results still reach your model provider like any other tool output. It is not claimed to be faster, and in the archived runs the equivalent setup scored below `full` in most comparisons (see [Evaluation](#evaluation)).

### Configuration

Configuration is optional. The file lives at `~/.pi/agent/extensions/pi-recall.json` (or under `$PI_CODING_AGENT_DIR` if you set it):

```json
{
  "mode": "full",
  "preindex": {
    "userCycles": 10,
    "toolRounds": 10
  }
}
```

Environment variables override the file, so you can also skip the file entirely:

| Variable | Overrides | Values |
| --- | --- | --- |
| `PI_RECALL_MODE` | `mode` | `full` or `lite` |
| `PI_RECALL_PREINDEX_TURNS` | `preindex.userCycles` | integer 1–100, default 10 |
| `PI_RECALL_PREINDEX_TOOL_ROUNDS` | `preindex.toolRounds` | integer 1–100, default 10 |

`preindex` only matters in `full`: messages not yet compacted are tokenized ahead of time every N completed user turns or N tool rounds, whichever comes first, so they are ready when compaction happens.
Settings are read once when the extension loads; restart Pi after changing them. Project `.pi/` directories are not read. Details, including SDK embedding, are in [doc/PLUGIN.md](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md).

## How it works

In `full`, each request after a compaction can go through three steps:

1. **Automatic hint.** Before the model answers, the extension matches your latest message against the compacted history and attaches up to five likely entry IDs (at most 1,500 characters). The hint applies to that request only and is never saved to the session.
2. **`history_recall`.** The model searches again with its own keywords and gets ranked entry IDs with short snippets.
3. **`history_expand`.** The model reads an entry's full text, plus neighboring messages, to confirm the exact detail.

If that is still not enough, **`history_grep`** offers a regex search over the same history. In `lite`, the model starts from `history_grep` and confirms with `history_expand`.

The extension never forces a tool call and never decides whether the evidence is sufficient; the model does. Snippets are leads, not answers.

```js
history_recall({ query: "bicycle repair", limit: 10 })
history_expand({ id: "ENTRY_ID", before: 1, after: 1 })
history_grep({ pattern: "bicycle|repair", limit: 10 })
```

| Tool | Returns |
| --- | --- |
| `history_recall` | Ranked, deduplicated entry IDs with date, role and snippet. Default and max 50 per page. `full` only. |
| `history_expand` | The requested entry first, then 2 neighbors on each side by default (0–20). Up to 16,000 characters per call. |
| `history_grep` | Case-insensitive JavaScript regex; invalid patterns fall back to literal text. Default 30, max 50 matching entries per page. |

Long results are paged. When `hasMore` is true, call again with the returned `nextOffset` and the same query; don't compute offsets yourself. Budgets count Unicode characters, not tokens. The full tool contract is in [doc/PLUGIN.md](https://github.com/shttty/pi-context-recall/blob/main/doc/PLUGIN.md).

## Limits

- **Current branch, compacted part only.** It searches what the latest compaction moved out of context: not the live context, other sessions, abandoned branches or the compaction summary. Before the first compaction there is nothing to search.
- **Keyword matching, not semantic search.** Synonyms, pronouns, spelling variants and single Chinese characters can be missed. No hit does not mean it was never said.
- **Searches user and assistant text plus tool-call arguments.** Tool results, thinking and images are not searched, though `history_expand` can show a tool result's text by ID.
- **Respects context edits.** Edited messages read as edited, hidden ones stay hidden, and content Pi has deleted cannot be recovered.
- **Privacy.** In `full`, hints are hidden in the UI but are sent to your model provider with the normal request. Old messages are marked untrusted and escaped; this reduces prompt-injection risk but does not remove it.
- **Cost.** `full` keeps an in-memory index in a worker thread for the current session; nothing is written to disk and nothing carries over between sessions. Tokenizing and searching run off the main thread, but the main thread still extracts text and hands it over, and the index takes extra memory that grows with the branch. The first lookup after startup or a compaction can wait for the index. If the worker fails, the extension falls back to scanning on the main thread with the same results. `lite` keeps no index; `history_grep` and `history_expand` scan the compacted history when called.

## Evaluation

The questions come from **[LongMemEval](https://github.com/xiaowu0162/LongMemEval)** (Di Wu et al., 2024; MIT), using the original **LongMemEval_M** histories. We picked M because each history runs to over a million tokens, about three times the 372k context window used in these runs, so every question has to get through real Pi compaction first. That is exactly the situation this extension is for.

Each history was fed to Pi in four segments, producing three native compactions, and then the question was asked. Two eight-question sets were used:

- **DEV8:** the evidence sits only in the compacted segments (single-session and temporal-reasoning questions).
- **HARD8:** the evidence is spread across at least two compacted segments; seven of the eight are multi-session questions. Picked for difficulty, not sampled at random.

Each question was answered three times from the same compacted snapshot: Pi alone with no tools, with the `lite` tool set, and with `full`. Each cell is correct answers out of 8.

| Set | Answer model | Pi alone | + `lite` | + `full` |
| --- | --- | --- | --- | --- |
| DEV8 | gpt-6-luna / high | 0 | 3 | 8 |
| HARD8 | gpt-6-luna / high | 0 | 1 | 3 |
| HARD8 | gpt-6.1-sol / high | 1 | 6 | 6 |

All rows used the same plugin build (`8149e1f`), from before the `lite`/`full` switch existed and before indexing moved into a worker. The `lite` column came from an evaluation wrapper that registered only `history_grep` and `history_expand` with the hint disabled (their descriptions were still the `full` wording); the `full` column used the synchronous scan of that build. Offline tests check that the current worker returns byte-identical hints and recall pages, but these numbers were not re-measured with the current code.

On HARD8, Luna and Sol answered from the same compacted snapshots, so only the answer model differs; Sol was not run on DEV8. Compression used gpt-6-luna / high; grading used gpt-6-luna with LongMemEval's official judge prompt.

**Scores depend heavily on the answer model.** With the same plugin and snapshots, Sol got 6 of 8 HARD8 questions and Luna got 3. The extension only brings compacted history back within reach; finding the right entries, combining evidence and answering correctly is still up to the model. With the `lite` tool set, Sol also reached 6, and its output limit was smaller (8,192 vs 128,000 tokens), so model, configuration and provider effects are not separated. Do not read the gap as an effect of the extension.

These are archived single runs on small, hand-picked sets, recorded during development rather than against the current release. `full` never scored below Pi alone, but eight questions per set cannot establish general accuracy or a causal effect.

Question IDs, selection rules, judge settings, earlier runs with other plugin builds, excluded runs and audit hashes are in [doc/BENCHMARK_RESULTS.md](doc/BENCHMARK_RESULTS.md). The LongMemEval data itself is not included.

## Development

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Tests run offline on synthetic fixtures. Real benchmark runs need an explicit external configuration; see the [evaluation guide](https://github.com/shttty/pi-context-recall/blob/main/doc/EVALUATION.md).

## License

MIT, Copyright (c) 2026 shttty. See [LICENSE](LICENSE).

LongMemEval attribution and its MIT notice are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#longmemeval-evaluation-material).
