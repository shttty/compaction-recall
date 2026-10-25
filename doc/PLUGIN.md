# Configuration and behavior reference

[English](PLUGIN.md) | [简体中文](PLUGIN.zh-CN.md)

compaction-recall currently supports Pi. It does not replace the host's compaction mechanism, persist an index, or make additional model calls. For installation and a quick introduction, see the [README](../README.md).

The public entry point is `src/index.ts`; `src/recall-extension.ts` is an alternative compatibility entry point. Load only one. Both only export or assemble components. `tools/` defines the descriptions, schemas, and execution of recall/grep/expand. `extension/` handles one-time configuration loading, index lifecycle and prewarming, automatic context, and shared branch and timing operations.

`history/` handles branch projection and location; `search/` handles queries and SQLite retrieval. `worker/` handles background scheduling and runs the plain mjs worker directly, without a TS worker loader. `observability/` handles timing and trace. Configuration, trace, index, and cadence are initialized at most once per extension load. For evaluation source responsibilities and commands, see the [running guide](benchmark.md).

## Choosing a mode

| Behavior | `full` (default) | `lite` |
|---|---|---|
| Tools | `history_recall`, `history_grep`, `history_expand` | `history_grep`, `history_expand` |
| Automatic hints | Provides short excerpts of relevant history and entry IDs before a response, wrapped in `<compacted-history-hints>` so the model can tell them from user text | Adds no automatic hints |
| Retrieval index | In-memory SQLite FTS5 database in a Node worker | Creates no index or worker |
| Prewarming | Maintains the index on session switches, compaction, and the configured interaction cadence | No prewarming |
| Optional timing | Indexing, queries, and tool calls | grep / expand tool calls |

In both modes, the model decides whether to search further and expand entries. `lite` does not provide privacy isolation: history returned by explicit tool calls still enters the model context and may be sent to the model provider.

## Pi configuration file

The configuration file is at `$PI_CODING_AGENT_DIR/extensions/compaction-recall.json`, defaulting to `~/.pi/agent/extensions/compaction-recall.json`. Create it manually if needed; the plugin does not generate it. Without a file, defaults or environment variables are used. All configuration fields are optional.

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
| `jieba` | `true` | Sets Han word boundaries for automatic queries with jieba. When disabled, automatic queries use `Intl.Segmenter`. Use a boolean in the file and `on` / `off` in the environment. | `COMPACTION_RECALL_JIEBA` |
| `autoGate` | `280` | Skips automatic hints when the user message exceeds this weighted length; explicit tool calls are unaffected. A positive safe integer. | `COMPACTION_RECALL_AUTO_GATE` |
| `snippetBudget` | `240` | Weighted-length budget for each original-text excerpt in automatic hints and explicit recall. A positive safe integer. | `COMPACTION_RECALL_SNIPPET_BUDGET` |
| `recallTimeoutMs` | `5000` | Cooperative timeout threshold for explicit recall, in milliseconds. A positive safe integer. | `COMPACTION_RECALL_QUERY_TIMEOUT_MS` |
| `preindex.userCycles` | `10` | Number of completed user interaction cycles before prewarming; range `1` to `100`. | `COMPACTION_RECALL_PREINDEX_TURNS` |
| `preindex.toolRounds` | `10` | Number of completed tool-call batches before prewarming; range `1` to `100`. Parallel calls in the same batch count only once. | `COMPACTION_RECALL_PREINDEX_TOOL_ROUNDS` |
| `trace` | `false` | Records content-bearing retrieval diagnostics; a timing file must also be specified. Accepts only a boolean. | None; file configuration only |

Weighted length counts each Chinese character as 2 and each other Unicode code point as 1. Reaching either prewarming threshold triggers prewarming. Retrieval, prewarming, and trace configuration apply only to `full`; timing logs are available in both modes.

### Handling configuration errors

- If the file does not exist, environment variables or defaults are used silently. If the file is unreadable, contains invalid JSON, or exceeds 65,536 bytes, it is ignored with a warning; unknown fields are ignored with a warning.
- Numeric environment variables must be decimal integer strings. Invalid values for `autoGate`, `snippetBudget`, and `recallTimeoutMs` fall back to defaults; an invalid environment override does not fall back to the file value.
- If a prewarming environment variable is invalid, a valid file value is retained; otherwise, the default is used.
- An invalid environment override for `mode` falls back to `full`; an invalid environment override for `jieba` falls back to enabled; an invalid `trace` value falls back to disabled. Diagnostics do not print the contents of invalid configuration values.

## Automatic history hints

`full` searches the current branch's compacted history using the most recent actual user message, borrowing a recent topic only when needed. It provides up to 5 location hints within a total display budget of 1,500 Unicode code points. No hints are added without current text, compacted history, or a match on a usable word.

- **Current-message byte minimum:** after trimming leading and trailing whitespace, a current message of at most 10 UTF-8 bytes skips automatic recall entirely, including topic borrowing (`继续`, `好的`, `ok`). Longer messages such as `那插件呢` (12 bytes) proceed normally, subject to the existing `autoGate` and usable-word rules.
- **Word boundaries:** the worker segments each Han run with the already-loaded jieba (`cut`, not overlapping search segments). With `jieba=false` or a load failure, it uses `Intl.Segmenter('zh')`. Adjacent single-character segments are merged; each word's ordered character bigrams become one FTS5 phrase. Cross-word fragments such as `移实` in `迁移实验` cannot match on their own. English, numbers, dotted runs and other scripts retain their existing lexical rules. The two segmenters can produce different boundaries and therefore different automatic candidates.
- **Usable words and stopwords:** only automatic queries filter the original `STOPWORDS` set in `src/search/sqlite-lexical.mjs`. Indexing and manual `history_recall` do not filter it. A usable word is not a stopword and matches at least one visible compacted record, as a complete Han phrase or another whole term (including existing English stemming). Every displayed record must match at least one usable word. Stopwords such as `这个`, `怎么`, `为什么` and `history` cannot independently trigger a hint; words outside the fixed set remain eligible regardless of how often they occur. The gate does not use raw BM25 scores.
- **Recent topics:** if the current message has a usable word, only its words are used. Otherwise, the worker checks the previous two user messages, nearest first, taken directly from this context event's `messages`. Only messages with a trimmed UTF-8 length strictly greater than 10 and strictly less than 240 bytes are eligible; ineligible messages are ignored without filling their slots from older messages. It borrows up to 4 usable terms from the nearest eligible message that has any, retaining the existing lower-record-frequency preference when selecting those terms. If neither message supplies one, no hint is added. Assistant/tool text is not borrowed; no topic state is stored between requests or sessions.

The default is `autoGate=280`: automatic queries are still allowed at a weighted length of exactly 280 and are skipped above it. This existing upper gate is unchanged: it measures the original current message's weighted length, not trimmed UTF-8 bytes or borrowed text. Longer messages are treated as instructions for a long task, keeping unrelated history out of the context; the model can still explicitly use retrieval tools.

Hints apply only to the current model request. They are not written to session history and do not accumulate across turns. They provide search leads and may leave relevant facts uncovered; expand the original text to verify important conclusions.

## Tool behavior

### `history_recall`: lexical retrieval

Available only in `full`. Use concept groups to specify what to find, alternative wording, and exclusions. Retrieval is lexical, not semantic.

- `concepts` accepts 1 to 5 groups, each with 1 to 8 alternative lexical forms. Any alternative within a group can match; `match="all"` requires every group to match in the same record, while the default `"any"` requires only one group to match. Within one lexical form, each contiguous Chinese or Japanese run must appear contiguously and in order (`长江大桥` does not match scattered `长江…江大…大桥`, and runs split by punctuation never join); separate words, such as `Rocky 8`, only need to appear in the same record, in any order.
- `exclude` accepts up to 5 lexical forms. Matching records are excluded and do not participate in excerpt selection. Lexical forms are not SQL, FTS MATCH syntax, or regular expressions.
- Groups, alternatives or exclusions beyond these counts are ignored and named in a warning instead of rejecting the call.
- Each lexical form must be nonempty after trimming leading and trailing whitespace, with at most 256 Unicode code points per form and 2,048 in total.
- If tokenization loses some valid characters, retrieval continues with the remaining terms and returns a warning. A lexical form with no searchable terms at all is ignored with a warning; only when no positive form remains does recall return an error. recall does not silently switch to grep; the model must rephrase or explicitly call grep when needed.
- The default and maximum for `limit` are both 50; `offset` defaults to 0. Results include entry IDs, original-text excerpts, the total count, and `nextOffset`; continue paging with the same query while the branch remains unchanged.

The index NFKC-folds both history text and queries, so fullwidth and halfwidth forms match each other (`１０．０．０．１` finds `10.0.0.1`, `ｶﾀｶﾅ` finds `カタカナ`); excerpts show the folded text, while `history_expand` still returns the original. Chinese and Japanese runs (Han plus kana) are indexed as adjacent character bigrams; other letters, numbers and combining marks form lowercase whole words, with English Porter stemming and camelCase/underscore components. Dotted runs such as `10.0.0.1`, `v8.0.23` or `config.py` are indexed both whole and as fragments: a full run ranks records containing it first, and a partial run such as `10.0.0` still matches by fragments. Single isolated Han characters are not indexed. FTS selects candidates; records with identical normalized full text are deduplicated, then ordered by BM25 and recency and paginated.

The worker sets Han word boundaries for automatic queries with `jieba-wasm`, a WebAssembly build of jieba-rs that loads in every runtime, including OMP's compiled extension host. If it cannot load, the plugin writes one warning to stderr and uses the runtime's built-in `Intl.Segmenter`. Manual recall does not use jieba.

### `history_grep`: regular-expression search

Available in both modes. `pattern` is a case-insensitive JavaScript regular expression; invalid syntax falls back to literal-text search, not SQL LIKE.

Matching records are paginated in branch order. `limit` defaults to 30 and has a maximum of 50; `offset` defaults to 0. Each page displays at most 30 representative excerpts, with at most 3 per record; body output is capped at 16,000 Unicode code points. The number of matches differs from the number of matching records; use `history_expand` to view content not shown in the excerpts.

grep has no regular-expression execution timeout; avoid complex expressions that could cause catastrophic backtracking.

### `history_expand`: expanding original text

Available in both modes. Reads the target entry by `id`; use `before` / `after` to include neighboring entries, defaulting to 2 on each side, with a range of `0` to `20`.

The target body is displayed first, with a per-page limit of 16,000 Unicode code points; neighbors that fit in full are added only after the target is displayed completely. Continue reading long entries with the returned `nextOffset`, measured in Unicode code points. This tool can expand readable tool results, but does not show thinking content or images.

Keep the query, target ID, and relevant parameters unchanged when paging. After an edit, compaction, or branch switch, query again from the first page.

## Scope, indexing, and timeouts

- Reads only history before the most recent compaction boundary on the current branch; does not cross into other sessions, parent sessions, or abandoned branches.
- recall and grep search user/assistant body text and assistant tool-call names and arguments, but not tool-result bodies, thinking content, images, or compaction summaries; readable tool results can still be expanded by ID.
- All tools and automatic hints respect context edits within the branch: omitted entries are invisible, replacements hide the original text, and edits cannot be bypassed to recover old content.
- The SQLite index resides only in memory. Session switches and compaction trigger maintenance; the index can be reused when compacted content is unchanged and is rebuilt when that content changes. Shutdown waits for the worker to close; no cross-session index is retained.
- Worker or transport failures return errors. The plugin does not silently switch to another retrieval algorithm.

`recallTimeoutMs` covers preparation, queueing, retrieval, and rendering for explicit requests. It is a cooperative timeout: SQLite's synchronous MATCH cannot be preempted, so the plugin discards expired results at checkpoints. The response may arrive later than the configured time. A timeout does not terminate a healthy worker or cancel other requests. If a request times out, narrow the query or use grep instead.

## Timing and diagnostic logs

No logs are written by default. Set `COMPACTION_RECALL_TIMING_FILE` to a JSONL file path to enable timing, for example:

```sh
COMPACTION_RECALL_TIMING_FILE="$HOME/compaction-recall-timing.jsonl" pi
```

Log files have permissions `0600`. `lite` records only grep / expand call chains; `full` can also record indexing and query stages. Process RSS, main-thread heap, and worker heap memory metrics are not mutually exclusive and cannot be added directly.

Set `"trace": true` in the configuration file to enable content-bearing diagnostics, including query parameters, returned entry IDs, pagination, and errors. trace also requires a timing-file path; without one, it warns and records nothing. It does not save thinking content, credentials, or raw provider requests. Logs may still contain conversation information. Keep them private and inspect them before sharing.
