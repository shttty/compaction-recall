# Configuration and behavior reference

[English](PLUGIN.md) | [简体中文](PLUGIN.zh-CN.md)

This guide covers compaction-recall's complete configuration, retrieval behavior, and limitations. For installation and a quick introduction, see the [README](../README.md). Pi is currently supported; the plugin does not replace the host's compaction mechanism, persist an index, or make additional model calls.

The public entry point remains `src/index.ts`, and the alternative compatibility entry point remains `src/recall-extension.ts`; load only one at a time. Both only export or assemble components: `tools/` owns the descriptions, schemas, and execution of recall/grep/expand, while `extension/` owns one-time configuration loading, index lifecycle/prewarming, automatic context, and shared branch/timing operations. `history/` (branch projection and location), `search/` (queries and SQLite retrieval), `worker/` (background scheduling and the plain mjs worker), and `observability/` (timing/trace) retain their existing responsibilities; configuration, trace, index, and cadence are not created more than once, and there are no new forwarding entry points or TS worker loaders. For evaluation source responsibilities and commands, see the [running guide](benchmark.md).

## Choosing a mode

| Behavior | `full` (default) | `lite` |
|---|---|---|
| Tools | `history_recall`, `history_grep`, `history_expand` | `history_grep`, `history_expand` |
| Automatic hints | Provides short excerpts of relevant history and entry IDs before a response | Adds no automatic hints |
| Retrieval index | In-memory SQLite FTS5 database in a Node worker | Creates no index or worker |
| Prewarming | Maintains the index on session switches, compaction, and the configured interaction cadence | No prewarming |
| Optional timing | Indexing, queries, and tool calls | grep / expand tool calls |

In both modes, the model decides whether to search further and expand entries. `lite` does not provide privacy isolation: history returned by explicit tool calls still enters the model context and may be sent to the model provider.

## Pi configuration file

The configuration file is at `$PI_CODING_AGENT_DIR/extensions/compaction-recall.json`, defaulting to `~/.pi/agent/extensions/compaction-recall.json`. **The file is not generated automatically**; without it, defaults or environment variables are used. All configuration fields are optional.

```json
{
  "mode": "full",
  "jieba": true,
  "autoGate": 280,
  "snippetBudget": 240,
  "recallTimeoutMs": 5000,
  "trace": false,
  "preindex": {
    "userCycles": 10,
    "toolRounds": 10
  }
}
```

Configuration is read once when the extension loads; reload after making changes. Environment variables take precedence over the file; the plugin does not read configuration files in the project directory. `PI_CODING_AGENT_DIR` is a Pi host setting, not a plugin configuration field. When embedding the extension through the Pi SDK, set it before loading as well; passing only the SDK's `agentDir` option does not change where the plugin looks for its configuration.

| Field | Default | Purpose and accepted values | Environment override |
|---|---|---|---|
| `mode` | `"full"` | Selects `full` or `lite`. | `COMPACTION_RECALL_MODE` |
| `jieba` | `true` | Reranks existing retrieval candidates using matches on long Chinese words; adds no candidates. Use a boolean in the file and `on` / `off` in the environment. | `COMPACTION_RECALL_JIEBA` |
| `autoGate` | `280` | Skips automatic hints when the user message exceeds this weighted length; explicit tool calls are unaffected. A positive safe integer. | `COMPACTION_RECALL_AUTO_GATE` |
| `snippetBudget` | `240` | Weighted-length budget for each original-text excerpt in automatic hints and explicit recall. A positive safe integer. | `COMPACTION_RECALL_SNIPPET_BUDGET` |
| `recallTimeoutMs` | `5000` | Cooperative timeout threshold for explicit recall, in milliseconds. A positive safe integer. | `COMPACTION_RECALL_QUERY_TIMEOUT_MS` |
| `preindex.userCycles` | `10` | Number of completed user interaction cycles before prewarming; range `1`–`100`. | `COMPACTION_RECALL_PREINDEX_TURNS` |
| `preindex.toolRounds` | `10` | Number of completed tool-call batches before prewarming; range `1`–`100`. Parallel calls in the same batch count only once. | `COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS` |
| `trace` | `false` | Records content-bearing retrieval diagnostics; a timing file must also be specified. Accepts only a boolean. | None; file configuration only |

Weighted length counts each Chinese character as 2 and each other Unicode code point as 1. Reaching either prewarming threshold triggers prewarming. Retrieval, prewarming, and trace configuration apply only to `full`; timing logs are available in both modes.

### Handling configuration errors

- If the file does not exist, environment variables or defaults are used silently. If the file is unreadable, contains invalid JSON, or exceeds 65,536 bytes, it is ignored with a warning; unknown fields are ignored with a warning.
- Numeric environment variables must be decimal integer strings. Invalid values for `autoGate`, `snippetBudget`, and `recallTimeoutMs` fall back to defaults; an invalid environment override does not fall back to the file value.
- If a prewarming environment variable is invalid, a valid file value is retained; otherwise, the default is used.
- An invalid environment override for `mode` falls back to `full`; an invalid environment override for `jieba` falls back to enabled; an invalid `trace` value falls back to disabled. Diagnostics do not print the contents of invalid configuration values.

## Automatic history hints

`full` searches the current branch's compacted history using the most recent actual user message, providing up to 5 location hints within a total display budget of 1,500 Unicode code points. No hints are added when there is no text, no searchable terms, no compacted history, or no matches.

The default is `autoGate=280`: automatic queries are still allowed at a weighted length of exactly 280 and are skipped above it. Longer messages are treated as instructions for a long task, keeping unrelated history out of the context; the model can still explicitly use retrieval tools.

Hints apply only to the current model request: they are not written to session history and do not accumulate across turns. They are only search leads, not a guarantee that all relevant facts are covered; expand the original text to verify important conclusions.

## Tool behavior

### `history_recall`: lexical retrieval

Available only in `full`. Use concept groups to express what to find, alternative wording, and exclusions; this is not semantic search.

- `concepts` accepts 1–5 groups, each with 1–4 alternative lexical forms. Any alternative within a group can match; `match="all"` requires every group to match in the same record, while the default `"any"` requires only one group to match. Matches on multiple words do not guarantee their order or adjacency in the original text.
- `exclude` accepts up to 5 lexical forms. Matching records are excluded and do not participate in excerpt selection or jieba ranking. Lexical forms are not SQL, FTS MATCH syntax, or regular expressions.
- Each lexical form must be nonempty after trimming leading and trailing whitespace, with at most 256 Unicode code points per form and 2,048 in total.
- If tokenization loses some valid characters, retrieval continues with the remaining terms and returns a warning; if no searchable terms remain, it returns an error. recall does not silently switch to grep; the model must rephrase or explicitly call grep when needed.
- The default and maximum for `limit` are both 50; `offset` defaults to 0. Results include entry IDs, original-text excerpts, the total count, and `nextOffset`; continue paging with the same query while the branch remains unchanged.

The index uses English stemming and Chinese character bigrams. FTS determines the candidates, and records with identical normalized full text are deduplicated. With jieba enabled, records are sorted first by the number of distinct long Chinese words matched, then by BM25 and recency, and finally paginated. jieba only helps order records that already matched: it does not expand synonyms or recover records that did not match.

Automatic queries usually use Chinese character bigram terms, which may not contain long words eligible for jieba ranking, so toggling jieba does not guarantee a change to every automatic hint.

### `history_grep`: regular-expression search

Available in both modes. `pattern` is a case-insensitive JavaScript regular expression; invalid syntax falls back to literal-text search, not SQL LIKE.

Matching records are paginated in branch order. `limit` defaults to 30 and has a maximum of 50; `offset` defaults to 0. Each page displays at most 30 representative excerpts, with at most 3 per record; body output is capped at 16,000 Unicode code points. The number of matches differs from the number of matching records; use `history_expand` to view content not shown in the excerpts.

grep has no regular-expression execution timeout; avoid complex expressions that could cause catastrophic backtracking.

### `history_expand`: expanding original text

Available in both modes. Reads the target entry by `id`; use `before` / `after` to include neighboring entries, defaulting to 2 on each side, with a range of `0`–`20`.

The target body is displayed first, with a per-page limit of 16,000 Unicode code points; neighbors that fit in full are added only after the target is displayed completely. Continue reading long entries with the returned `nextOffset`, measured in Unicode code points. This tool can expand readable tool results, but does not show thinking content or images.

Keep the query, target ID, and relevant parameters unchanged when paging. After an edit, compaction, or branch switch, query again from the first page.

## Scope, indexing, and timeouts

- Reads only history before the most recent compaction boundary on the **current branch**; does not cross into other sessions, parent sessions, or abandoned branches.
- recall and grep search user/assistant body text and assistant tool-call names and arguments, but not tool-result bodies, thinking content, images, or compaction summaries; readable tool results can still be expanded by ID.
- All tools and automatic hints respect context edits within the branch: omitted entries are invisible, replacements hide the original text, and edits cannot be bypassed to recover old content.
- The SQLite index resides only in memory. Session switches and compaction trigger maintenance; the index can be reused when compacted content is unchanged and is rebuilt when that content changes. Shutdown waits for the worker to close; no cross-session index is retained.
- Worker or transport failures return errors, rather than silently switching to another retrieval algorithm.

`recallTimeoutMs` covers preparation, queueing, retrieval, and rendering for explicit requests, but is not a forced-interruption timer: SQLite's synchronous MATCH cannot be preempted, and the plugin discards expired results at checkpoints. The actual response may therefore arrive later than the configured time. A timeout does not terminate a healthy worker or cancel other requests; if a request times out, narrow the query or use grep instead.

## Timing and diagnostic logs

No logs are written by default. Set `COMPACTION_RECALL_TIMING_FILE` to a JSONL file path to enable timing, for example:

```sh
COMPACTION_RECALL_TIMING_FILE="$HOME/compaction-recall-timing.jsonl" pi
```

Log files have permissions `0600`. `lite` records only grep / expand call chains; `full` can also record indexing and query stages. Process RSS, main-thread heap, and worker heap memory metrics are not mutually exclusive and cannot be added directly.

Only after also setting `"trace": true` in the configuration file are content-bearing diagnostics such as query parameters, returned entry IDs, pagination, and errors recorded. Without a timing file, trace only warns and records nothing. trace does not save thinking content, credentials, or raw provider requests, but it may still contain conversation information: keep it private and inspect its contents before sharing.
