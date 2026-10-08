# compaction-recall

[English](https://github.com/shttty/compaction-recall/blob/main/README.md) | [简体中文](https://github.com/shttty/compaction-recall/blob/main/README.zh-CN.md)

An extension that helps AI agents recover details from compacted conversations.

Summaries can lose names, numbers and exact wording. compaction-recall lets the model search the original messages on the current branch and expand the relevant evidence, without replacing the agent's own compaction.

- **Local, in-memory retrieval.** SQLite FTS5 runs in a Node worker, with no persistent index, embedding service or extra model calls.
- **English and Chinese support.** English stemming and Chinese character-bigram indexing, with optional jieba-based ranking of existing matches.
- **Two modes.** `full` provides automatic history hints and three tools; `lite` keeps only grep and expansion, without an index or worker.

## Installation

Currently supports Pi, with support for other agents planned.

### Pi

Requires [Pi](https://github.com/badlogic/pi-mono) and **Node.js >=24.18.0**. Tested with Pi SDK **1.0.0**.

Install from npm:

```sh
pi install npm:pi-compaction-recall
```

The configuration file lives in the Pi profile's agent extensions directory: `$PI_CODING_AGENT_DIR/extensions/compaction-recall.json` (default: `~/.pi/agent/extensions/compaction-recall.json`). **It is not generated automatically**; create it manually if needed. Without it, defaults and environment variables are used.

## Tools

In `full` mode, short history hints are added before answers. The model decides when to search or expand further.

| Tool | Purpose |
|---|---|
| `history_recall` | Search compacted history with concept groups, alternative wording and exclusions. |
| `history_expand` | Read an original entry by ID, with optional neighboring entries and pagination. |
| `history_grep` | Search with a JavaScript regular expression, independently of recall. |

## Configuration

Unset fields use defaults; environment variables override the configuration file. Reload after changes.

| Setting | Default | Description | Environment override |
|---|---|---|---|
| `mode` | `"full"` | `full`: automatic hints and three tools; `lite`: grep/expand only. | `COMPACTION_RECALL_MODE` (`full`/`lite`) |
| `jieba` | `true` | Rank existing FTS candidates by long Chinese terms before pagination. | `COMPACTION_RECALL_JIEBA` (`on`/`off`) |
| `autoGate` | `280` | Treat longer user messages as task instructions and skip automatic recall to avoid adding unrelated history; the model can still search with tools (Han codepoints count as 2, others as 1). | `COMPACTION_RECALL_AUTO_GATE` |
| `snippetBudget` | `240` | Source-text budget per automatic hint or `history_recall` result; higher values allow longer excerpts (Han codepoints count as 2, others as 1). | `COMPACTION_RECALL_SNIPPET_BUDGET` |
| `recallTimeoutMs` | `5000` | Manual recall deadline in milliseconds; native MATCH cannot be interrupted. | `COMPACTION_RECALL_QUERY_TIMEOUT_MS` |
| `preindex.userCycles` | `10` | Completed user exchanges before preparation; integer `1`–`100`, either preindex threshold triggers. | `COMPACTION_RECALL_PREINDEX_TURNS` |
| `preindex.toolRounds` | `10` | Completed tool batches before preparation; integer `1`–`100`, parallel calls count once per batch. | `COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS` |
| `trace` | `false` | Content-bearing recall diagnostics; requires the timing-file path and should stay private. | File only |
| `COMPACTION_RECALL_TIMING_FILE` | Unset | JSONL timing output path; unset means no timing log. | Environment only |


Retrieval, preindex and trace settings apply to `full` mode. Details: [Configuration and behavior reference](https://github.com/shttty/compaction-recall/blob/main/doc/PLUGIN.md).

## Scope and privacy

- Searches only compacted history on the **current branch**, not other sessions or abandoned branches.
- Indexes user/assistant text and assistant tool-call names and arguments. Thinking, images, tool-result bodies and compaction summaries are not indexed; readable tool results can still be expanded by ID.
- Honors branch-local context edits: omitted entries stay unavailable, and replacement text hides the original.
- Hints and tool results enter the model's context and may be sent to its provider. `lite` disables automatic hints, not the transmission of explicitly retrieved history.

An empty result does not prove a detail was never mentioned. Verify important facts against the expanded source. Diagnostic traces can contain conversation content and should not be published.

## Benchmarks

Evaluation uses selected [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) cases. The repository includes 16 Chinese question translations, source identifiers, processing notes, result metrics and reproduction scripts; original corpora and other full-text evaluation inputs are obtained separately.

Answering model: `gpt-6-luna` (high). Scores are correct answers / questions, split into DEV8 and HARD8 (eight questions each).

### Historical best

| Mode | DEV8 | HARD8 | Combined peaks |
|---|---:|---:|---:|
| Pi native | 2/8 | 0/8 | 2/16 |
| lite | 2/8 | 0/8 | 2/16 |
| full | 8/8 | 3/8 | 11/16 |

### Random test run

A single run on the fixed English LongMemEval_M set. The native baseline has retained context only, without history-retrieval tools.

| Mode | DEV8 | HARD8 | Total |
|---|---:|---:|---:|
| Pi native | 0/8 | 0/8 | 0/16 |
| lite | 2/8 | 0/8 | 2/16 |
| full | 7/8 | 3/8 | 10/16 |

These small development-set results are not full LongMemEval scores or a guarantee of recall accuracy.

See the [benchmark guide](https://github.com/shttty/compaction-recall/blob/main/doc/benchmark.md) for commands and required inputs.

## Development

```sh
npm ci --ignore-scripts
npm run check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'test_*.py'
```

Tests use synthetic fixtures and isolated agent directories. Live benchmarks need external data and provider configuration and may incur model API costs.

## License

[MIT](https://github.com/shttty/compaction-recall/blob/main/LICENSE). Third-party software and dataset attribution are listed in [THIRD_PARTY_NOTICES.md](https://github.com/shttty/compaction-recall/blob/main/THIRD_PARTY_NOTICES.md).
