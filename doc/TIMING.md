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
| `live_or_eligible_tokenization`, `large_text_assembly` | Retained transport labels: SQLite stages raw entries (no prepareEntry token cache); joins chunked text |
| `postings_activation` | Retained label for the SQLite in-memory build/rebuild, including native FTS and auxiliary Han ranking table |
| `critical_path_index_wait` | Actual foreground wait for a required generation; not worker CPU time |
| `concept_query_compile`, `native_count`, `native_query` | Author concept compilation; native distinct-content count; SQL MATCH/BM25/representatives/long-surface order and LIMIT/OFFSET |
| `candidate_collection`, `candidate_materialization`, `snippet_hits`, `snippet_selection`, `snippet_render` | SQLite collector, actual selected-row materialization and lazy page snippets; full-rank diagnostic callers materialize all selected rows |
| `auto_render_budget`, `manual_snippets_pagination_render` | Shared snippet/render budget and manual pagination logic |
| `grep_scan`, `grep_pagination_render`, `expand` | Actual synchronous grep scan/page rendering and readable expansion |
| `preindex_scheduled` mark | Trigger source, user counter, tool counter and scheduling thread; never message contents |
| `worker_maintenance`, `index_maintenance` marks | Maintenance kind, entry count and executing thread |
| `worker_online`, `background_index_ready`, `worker_failed`, `fallback_required` marks | Retained lifecycle/readiness/failure labels, without error text/content; fallback_required does not mean SQLite production selects a scan |
| `index_memory` mark | After each successful worker commit: numeric `processRssBytes`, `mainHeapUsedBytes`, `workerHeapBytes` and `entries`; only sampled with a timer and `COMPACTION_RECALL_TIMING_FILE` |

`session_start` schedules prewarm, cadence callbacks stage live records, `session_compact` refreshes eligible history, and `session_tree` invalidates the branch. Live prewarm waits for active foreground lookups instead of cancelling a valid query. SQLite has no old live-token/DF cache or synchronous scan fallback: eligible projection changes rebuild the index; worker failures propagate. Shutdown awaits termination. [BACKGROUND_INDEX.md](BACKGROUND_INDEX.md) defines the current SDK 1.0.0 lifecycle and batching contract. The prior JS stage table and fallback/cache description remain unchanged in `archive/js-runtime/original-docs/doc/TIMING.md`.

## Interpretation and privacy

Durations use monotonic `performance.now()` in Node. Spans are **inclusive**, carry UUID-qualified IDs and parent IDs, and retain actual execution labels (`synchronous_main_thread`, `worker_thread`, or `awaited_walltime`). AsyncLocalStorage prevents concurrent tools from being falsely nested. Worker origins are carried back and rebased into the main observer's time origin; worker execution duration is not inferred by subtracting roundtrip and main-thread time.

Do not add parent spans to their children, background preparation to foreground readiness waiting, or overlapping RPC/query operations. Background work is not free and cannot be subtracted from user-visible latency. Timing/logging overhead remains part of outer wall time. A slow cold build, main-thread extraction, fallback scan and additional worker memory remain real costs.

### Commit memory samples

Each completed worker commit (initial build, rebuild, eligibility activation or live maintenance) samples process `rss` and main-thread `heapUsed` from `process.memoryUsage()`, then awaits that worker's `Worker.getHeapStatistics()` and records `used_heap_size` as `workerHeapBytes`. `entries` is the engine's indexed-document count, not all retained/live messages. The additional mark payload contains numbers only; the standard timing envelope retains its fixed stage/thread labels. `trace: true` is not required. Without a timing destination, the new main-thread memory and `Worker.getHeapStatistics()` samples are not taken. The legacy `background_index_ready.workerHeapBytes` remains the worker-side `process.memoryUsage().heapUsed` returned at commit whenever a timer is supplied, including explicit benchmark timers without a destination. With production timing disabled, no timer is supplied and neither legacy nor new memory samples run.

These are **three different measurements; do not add them**. RSS covers the entire process, including worker runtimes, code, native allocations and allocator high-water marks. Main heap is the calling V8 isolate; worker heap is that worker's V8 isolate and **is not the pure index size**. SQLite/native index allocations may appear only in RSS, not either JavaScript heap. The worker heap reply arrives after the main sample; no explicit main/worker GC is performed. These marks are not baseline-subtracted plugin overhead or an atomic snapshot. Compare equivalent baseline runs separately to estimate incremental cost. A failed or cancelled sample is omitted and cannot fail an otherwise completed index.


With `trace` disabled (the default), metadata is allowlisted: numeric counts/durations and fixed operation/kind/trigger/thread labels. Timing events do not record body text, queries, snippets, tool parameters, credentials, URLs, headers or exception messages. Worker result payloads still carry the requested retrieval output, but those payloads are not timing events.

### Opt-in content trace

Set `"trace": true` in `<agentDir>/extensions/compaction-recall.json` to append one `history_recall_trace` JSONL event per executed `history_recall` call to the same `COMPACTION_RECALL_TIMING_FILE`. This is file-only, defaults to false, and accepts only booleans; invalid values warn and use false. True without a timing destination warns once at extension load and does not record. Lite adds no trace hooks. Tool descriptions and returned output do not change.

**Trace contains sensitive content:** assistant text blocks and parsed tool arguments, execute parameters and structured concepts/match/exclude input, ranked returned IDs, pagination and original error messages. It captures neither thinking nor verbatim provider wire. Inputs can contain secrets; protect the file. Both writers create/chmod it to 0600. Missing/failed writes remain output-neutral and do not establish complete coverage.

`src/recall-trace.mjs` is directly importable JavaScript using only Node filesystem APIs. Production calls `createRecallTrace({ enabled, path, warn, inputFields: ['concepts', 'match', 'exclude'] })`; archived query-based harnesses retain the generic query schema when inputFields is omitted. Disabled/missing-path calls return undefined. An enabled collector exposes:

- `messageEnd(sessionId, message)`: snapshot assistant `history_recall` ToolCall arguments, matched by name/id, and all same-message text blocks.
- `toolCall(sessionId, event)`: capture an explicit nested `parentToolCallId`; never substitute mutable `event.input` for model arguments.
- `begin(sessionId, toolCallId, params)`: snapshot execute input, return a token and increment a 1-based per-session call index. If input serialization fails, drop that diagnostic event and return `undefined`; completion/error methods accept this token without changing tool behavior.
- `complete(token, { ids, total, offset, returned, nextOffset })` / `fail(token, error)`: snapshot the page or preserve the original error message.
- `flush()`: emit queued calls once at `agent_end` / `session_shutdown`, then discard correlation state. Execute may precede `message_end`; flushing on tool completion would incorrectly mark model data missing. Session call counters survive flushes.

Production events have `{ type: 'history_recall_trace', sessionId, callIndex, toolCallId, parentToolCallId, model, execute, input_identical, result, error }`. model is `{ arguments, textBlocks }` or null; execute is `{ params, input: { concepts?, match?, exclude? } }`; result is the page above or null; error is the original `{ name, code, message }` or null. ids preserve returned order. input_identical compares unmodified JSON snapshots of selected input fields (including property order); it is null when model data is missing, with no semantic normalization. Explicit/SDK-inferred nested parents have null model data. Full params preserve unknown fields; unserializable diagnostics drop the event rather than replacing the original tool result/error. Historical generic collectors without inputFields retain execute.query/query_identical and message-only errors; those are not the current production contract.

SDK 1.0.0 evidence: `dist/core/extensions/types.d.ts` defines `MessageEndEvent.message: AgentMessage`, mutable `ToolCallEvent.input` (`ToolCallEventResult` explicitly instructs in-place mutation), and nested `parentToolCallId` / `<parent>/<n>` IDs; `dist/core/session-manager.d.ts` exposes `getSessionId()`. The bundled `@earendil-works/pi-ai/dist/types.d.ts` defines assistant content as `(TextContent | ThinkingContent | ToolCall)[]`, `TextContent.text: string`, and `ToolCall.arguments: JsonObject`. These are separate observations, not an assumption that tool input still equals model output.

## Benchmark-only experience events

`benchmark/pi-stage-events.mjs` imports the production timer. It records observable SDK milestones separately: `session_start`, `provider_request_prepared`, `provider_response_headers`, first visible/thinking/tool-call delta and `assistant_response_end`. Prepared-to-first-visible is not genuine server TTFT or terminal paint time. The Python runner's process wall time and RPC startup/compaction timings use its own monotonic clock; separate process clocks are not subtracted as a shared timeline. No streaming content, headers or credentials are logged.

## Offline verification and historical evidence

Offline checks exercise current SQLite warnings/zero-token, SQL order before pagination, branch scope, lite, structured trace and isolated SDK loading; archived JS tests separately retain scan parity/token-cache/fallback coverage. Shared timing tests cover worker spans/parents, parallel span isolation, disabled measurement clocks/writes, privacy, 0600 and output-neutral failures. SDK/worker checks require empty child stderr without warning suppression. They do not call a model or establish provider latency.

`node archive/benchmark/timing-smoke.mjs --source SESSION_JSONL --query TEXT` is a historical synchronous **JS** diagnostic, now explicitly importing `archive/js-runtime/`; it is not the SQLite production worker. Source/query must be explicit. Default output is a unique temporary directory; an explicit new path uses exclusive creation. This source migration did not rerun the historical real-history smoke.

The frozen [timing-smoke-results.json](../archive/benchmark/timing-smoke-results.json) measured the earlier lazy synchronous index, not the production worker. Historical Pi DEV8 wall-time/usage/tool-count results retain only fields actually captured: missing streaming or tool stages are unavailable, never backfilled. The earlier 14.71/24.40/26.46-second medians and the later [timed DEV8](../archive/doc/PI_DEV8_TIMED.md) remain distinct historical measurements. No historical JSON, manifest, provenance or results document was relabeled or overwritten.
