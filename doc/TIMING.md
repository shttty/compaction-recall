# Optional production stage timing

`src/timing.mjs` contains the shared JavaScript `StageTiming`, `measured` helper and production `recallTiming` observer, with JSDoc types checked by TypeScript. Main thread and worker import this single implementation directly; no runtime TypeScript loader is needed. **Only `COMPACTION_RECALL_TIMING_FILE` enables production timing.** Without it there are no measurement clock reads, log writes or timing events on either thread; worker batching uses fixed entry/character limits, not a scheduling clock. The benchmark event observer is also disabled without a supplied timer.

```sh
COMPACTION_RECALL_TIMING_FILE=/absolute/private/directory/recall.jsonl pi -e ./src/index.ts
```

The parent directory must already exist. Logs are append-only JSONL, created with mode **0600**; existing files are chmodded to 0600 before writing. Logging failures are swallowed and never change tool output or its original error. The in-memory event buffer is bounded to 10,000 events and reports dropped measurements when flushed. Missing, failed or truncated logs are not complete traces.

## Production stages

| Stage / mark | Actual boundary |
|---|---|
| `auto_context_total` | Full awaited context hook, including retrieval and context-message transformation |
| `tool_history_recall_total`, `tool_history_grep_total`, `tool_history_expand_total` | Full tool execution until its returned result settles |
| `branch_copy` | `sessionManager.getBranch()` |
| `main_branch_selection`, `branch_projection`, `compacted_selection` | Raw-reference validation, branch-effective `context_edit` projection and raw compaction-boundary selection |
| `branch_selection_projection`, `branch_selection` | Shared scan/tool or index branch selection |
| `query_text_extraction`, `main_text_extraction`, `text_extraction` | Actual query/source extraction, including canonical tool-input serialization where applicable |
| `background_prepare` | Awaited worker generation preparation; includes main extraction, transfer and worker work |
| `worker_post_message` | Synchronous structured-clone submission, not total transfer latency |
| `worker_roundtrip_begin/batch/large_start/large_chunk/large_end/commit/query` | Awaited RPC wall time, including dispatch/queue/transfer and worker execution |
| `worker_begin/batch/large_start/large_chunk/large_end/commit/query` | Actual worker request execution; transferred spans retain `execution: worker_thread` |
| `live_or_eligible_tokenization`, `large_text_assembly` | Worker token-cache creation and assembly of chunked source text |
| `eligible_activation_selection`, `postings_activation` | Select compacted entries and activate cached token maps; live entries do not enter postings, DF or N |
| `index_sync`, `index_build_tokenize_postings`, `index_update_tokenize_postings` | Index validity/maintenance. In the worker, already-tokenized entries activate cached postings; the retained stage names also serve the standalone synchronous index |
| `critical_path_index_wait` | Actual foreground wait for a required generation; not worker CPU time |
| `query_tokenization`, `postings_search`, `candidate_materialization` | Lexical query preparation, posting lookup and candidate creation |
| `deduplicate`, `mechanical_rank` | Shared dedupe-before-ranking logic |
| `auto_render_budget`, `manual_snippets_pagination_render` | Shared snippet/render budget and manual pagination logic |
| `grep_scan`, `grep_pagination_render`, `expand` | Actual synchronous grep scan/page rendering and readable expansion |
| `synchronous_scan_fallback`, `scan_candidates`, `document_tokenization` | Exact shared scan after worker failure, including its nested query/extraction/ranking/render stages |
| `preindex_scheduled` mark | Trigger source, user counter, tool counter and scheduling thread; never message contents |
| `worker_maintenance`, `index_maintenance` marks | Maintenance kind, entry count and executing thread |
| `worker_online`, `background_index_ready`, `worker_failed`, `fallback_required` marks | Lifecycle/readiness/failure observations, without error text or source content |

`session_start` schedules prewarm, cadence callbacks schedule live-token batches, `session_compact` schedules eligibility maintenance, and `session_tree` invalidates the branch. A queued live prewarm waits for active foreground lookups rather than cancelling a valid cold query. Worker failure selects synchronous scan until an explicit lifecycle reset; shutdown awaits termination. [BACKGROUND_INDEX.md](BACKGROUND_INDEX.md) defines the SDK 1.0.0 lifecycle and batching contract.

## Interpretation and privacy

Durations use monotonic `performance.now()` in Node. Spans are **inclusive**, carry UUID-qualified IDs and parent IDs, and retain actual execution labels (`synchronous_main_thread`, `worker_thread`, or `awaited_walltime`). AsyncLocalStorage prevents concurrent tools from being falsely nested. Worker origins are carried back and rebased into the main observer's time origin; worker execution duration is not inferred by subtracting roundtrip and main-thread time.

Do not add parent spans to their children, background preparation to foreground readiness waiting, or overlapping RPC/query operations. Background work is not free and cannot be subtracted from user-visible latency. Timing/logging overhead remains part of outer wall time. A slow cold build, main-thread extraction, fallback scan and additional worker memory remain real costs.

With `trace` disabled (the default), metadata is allowlisted: numeric counts/durations and fixed operation/kind/trigger/thread labels. Timing events do not record body text, queries, snippets, tool parameters, credentials, URLs, headers or exception messages. Worker result payloads still carry the requested retrieval output, but those payloads are not timing events.

### Opt-in content trace

Set `"trace": true` in `<agentDir>/extensions/compaction-recall.json` to append one `history_recall_trace` JSONL event per executed `history_recall` call to the same `COMPACTION_RECALL_TIMING_FILE`. This is file-only, defaults to false, and accepts only booleans; invalid values warn and use false. True without a timing destination warns once at extension load and does not record. Lite adds no trace hooks. Tool descriptions and returned output do not change.

**Trace contains sensitive content:** the assistant's text blocks and parsed tool arguments, execute parameters/query, ranked returned IDs, pagination and original error messages. It does not capture thinking blocks or the verbatim wire JSON. Query text and parameters can contain secrets; protect and retain the file accordingly. Both timing and trace writers create/chmod the shared file to 0600. Missing or failed writes remain output-neutral and do not establish complete coverage.

`src/recall-trace.mjs` is directly importable JavaScript using only Node filesystem APIs; production and evaluation harnesses share `createRecallTrace({ enabled, path, warn })`. Disabled/missing-path calls return `undefined`. An enabled collector exposes:

- `messageEnd(sessionId, message)`: snapshot assistant `history_recall` ToolCall arguments, matched by name/id, and all same-message text blocks.
- `toolCall(sessionId, event)`: capture an explicit nested `parentToolCallId`; never substitute mutable `event.input` for model arguments.
- `begin(sessionId, toolCallId, params)`: snapshot execute input, return a token and increment a 1-based per-session call index. If input serialization fails, drop that diagnostic event and return `undefined`; completion/error methods accept this token without changing tool behavior.
- `complete(token, { ids, total, offset, returned, nextOffset })` / `fail(token, error)`: snapshot the page or preserve the original error message.
- `flush()`: emit queued calls once at `agent_end` / `session_shutdown`, then discard correlation state. Execute may precede `message_end`; flushing on tool completion would incorrectly mark model data missing. Session call counters survive flushes.

Each event has `{ type: "history_recall_trace", sessionId, callIndex, toolCallId, parentToolCallId, model, execute, query_identical, result, error }`. `model` is `{ arguments, textBlocks: string[] }` or null; `execute` is `{ params, query }`; `result` is the page object above or null; `error` is the original message or null. `ids` follow returned ranking, not corpus order. `query_identical` is null only when model output is missing. Otherwise strings use exact equality; Query JSON uses equality of the unmodified `JSON.stringify` snapshots (including property order), without normalization or query mutation. Nested calls carry the explicit parent or the parent inferred from SDK `<parent>/<n>` IDs and always have null model data. Unknown fields in arguments/params are preserved. Unserializable diagnostic inputs, model arguments or results drop their event rather than replacing the tool's original result/error. Harnesses supply prototype/language/question association outside this schema.

SDK 1.0.0 evidence: `dist/core/extensions/types.d.ts` defines `MessageEndEvent.message: AgentMessage`, mutable `ToolCallEvent.input` (`ToolCallEventResult` explicitly instructs in-place mutation), and nested `parentToolCallId` / `<parent>/<n>` IDs; `dist/core/session-manager.d.ts` exposes `getSessionId()`. The bundled `@earendil-works/pi-ai/dist/types.d.ts` defines assistant content as `(TextContent | ThinkingContent | ToolCall)[]`, `TextContent.text: string`, and `ToolCall.arguments: JsonObject`. These are separate observations, not an assumption that tool input still equals model output.

## Benchmark-only experience events

`benchmark/pi-stage-events.mjs` imports the production timer. It records observable SDK milestones separately: `session_start`, `provider_request_prepared`, `provider_response_headers`, first visible/thinking/tool-call delta and `assistant_response_end`. Prepared-to-first-visible is not genuine server TTFT or terminal paint time. The Python runner's process wall time and RPC startup/compaction timings use its own monotonic clock; separate process clocks are not subtracted as a shared timeline. No streaming content, headers or credentials are logged.

## Offline verification and historical evidence

Offline tests check scan/worker output parity, cache activation without re-tokenization, worker-thread spans and parent links, parallel span isolation, zero disabled clock reads/writes, privacy filtering, 0600 permissions and output-neutral logging failures. The isolated SDK loader test exercises standalone and installed `node_modules` layouts, the package and both TypeScript entries, with timing off and on. Startup, queries and awaited worker shutdown must finish with empty child-process stderr; no warning suppression is installed. These checks do not call a model or establish end-to-end provider latency.

`node benchmark/timing-smoke.mjs --source SESSION_JSONL --query TEXT` remains a **synchronous index diagnostic**, now importing `src/`; it is not a production worker benchmark. Source/query must be explicit. By default its output goes to a unique OS temporary directory; `--output NEW_PATH` uses exclusive creation and must not target frozen evidence. This migration did not rerun the real-history smoke.

The frozen [timing-smoke-results.json](../benchmark/timing-smoke-results.json) measured the earlier lazy synchronous index, not the production worker. Historical Pi DEV8 wall-time/usage/tool-count results retain only fields actually captured: missing streaming or tool stages are unavailable, never backfilled. The earlier 14.71/24.40/26.46-second medians and the later [timed DEV8](PI_DEV8_TIMED.md) remain distinct historical measurements. No historical JSON, manifest, provenance or results document was relabeled or overwritten.
