# Forward-only stage and user-experience timing

Added after the completed Pi DEV8 run. Historical results retain only the wall times, usage and tool counts actually captured; their missing streaming/tool-stage times are **unavailable**, never backfilled. No paid benchmark was rerun to add these fields.

## What is instrumented

All durations are milliseconds from monotonic clocks (`performance.now` inside Node; `time.monotonic` in the Python runner). Clocks from separate processes are not subtracted or treated as a shared timeline.

| Metric | Measured boundary | Interpretation |
|---|---|---|
| Answer wall time | Before preflight/process launch → full Pi process exit | End-to-end attempt, includes startup, tools, model/network and logging |
| startupToRpcReadyMs | Before Popen → response to `get_state` | Compaction-process launch/readiness handshake, not first token |
| compactionRpcWallMs | Immediately before sending compact command → matching RPC response | Includes native Pi internal summaries/network; may contain multiple model requests |
| session_start | Event time and Node process uptime | Session lifecycle milestone; not a claim of provider readiness or exact parent-spawn latency |
| provider_request_prepared | SDK before_provider_request callback | Start of observable request path, not confirmed wire send |
| provider_response_headers | after_provider_response callback | Response headers observed, not first model token |
| first_visible_text_delta | First text_delta for this request | Time from request-prepared to first SDK-visible text; not genuine server TTFT or terminal-paint time |
| first_thinking_delta / first_toolcall_delta | First respective streaming event | Kept separate from visible text |
| assistant_response_end | Assistant message_end | Request-prepared → completed SDK response, includes network/model/dispatch; not pure inference CPU time |
| tool_history_*_total | Adapter execute invocation → settled return | Awaited tool wall time including nested retrieval work |
| auto_context_total | Auto hint transform invocation → result | Synchronous work on the critical path before model request |
| branch_copy / branch_selection / index_sync | Actual getter, compacted selection, full synchronization | Includes branch validity checking even on warm lookup |
| index_build_tokenize_postings | Source extraction, history lexing and postings construction | These operations remain combined; no fabricated independent history-tokenizer number |
| index_update_tokenize_postings | New compacted-entry indexing | Emitted only when entries are added, not a false warm-cache update |
| query_tokenization / postings_search / candidate_materialization | Respective actual lexical stages | Synchronous CPU work |
| deduplicate / mechanical_rank | Shared production helpers | Dedupe before ranking |
| auto_render_budget / manual_snippets_pagination_render | Shared rendering/pagination helpers | Includes snippet extraction/metadata/budget calculations |

Request callbacks may not expose all internal compaction responses. Missing events remain absent rather than synthesized. Request IDs are local sequence numbers; no prompts, snippets, arguments, tokens, credentials, URLs or headers are recorded. Event tests explicitly use sentinel secrets to verify they do not enter logs.

## Cold work, maintenance and perceived waiting

The current experimental index **does not run in a background worker and has no compaction hook**. It lazily synchronizes at the first context or recall lookup:

- Initial build: synchronous on Pi's main thread, delays the first model request/tool result
- Warm lookup: still copies/selects/checks the compacted branch, then searches existing postings
- Incremental update: next lookup indexes newly compacted entries synchronously
- Branch/reset rebuild: next lookup replaces invalid state synchronously

An `index_maintenance` mark identifies `initial_build`, `incremental_update`, or `branch_rebuild`, with trigger `lazy_context_or_tool_lookup`, entry count and `synchronous_main_thread` execution. “Maintenance” does not mean free or asynchronous. Background queue delay/overlap and background CPU duration are unavailable because no such mechanism exists. There is no subtraction of index time from user-facing latency.

Spans carry IDs and parent IDs, with **inclusive durations**. Sum only comparable non-overlapping spans; never add `index_sync` to its nested build duration or a whole tool to its child stages. AsyncLocalStorage prevents concurrently executing tools being falsely nested under one another. Event buffers/log writes have overhead, and that overhead remains in outer process wall time. No claim of zero instrumentation overhead.

## Offline real-history smoke

`node benchmark/timing-smoke.mjs` reads one existing saved real DEV8 history, uses the actual question, then measures cold auto, warm auto, warm manual, and first/next compaction-boundary indexing. It makes no model calls and accesses no credentials. Results and the span hierarchy are in [timing-smoke-results.json](../benchmark/timing-smoke-results.json).

This is one local smoke, not a latency distribution. It demonstrates that first-build blocking can be materially larger than warm search; do not present it as a production p95. The prior full Pi run's 14.71/24.40/26.46-second medians are different measurements and remain unchanged.

## Enable and verify

The runner sets `PI_RECALL_TIMING_FILE` to each attempt's ignored timing.jsonl and loads the event extension. The experimental indexed adapter uses the same optional timer for auto hints and tools. Production entrypoints do not enable it. Logs are bounded in memory (10,000 pending events) and flushed between operations; writes never change tool responses if logging fails. Missing/truncated logs should not be treated as complete traces.

Files: `../timing.ts`, `../prototype/stage-timing.mjs`, `pi-stage-events.mjs`, the indexed adapter/index, shared locator helpers, runner and smoke script. Offline checks cover output parity, cold/warm/update stage presence, nested/parallel spans, streaming milestones without content logging, Unicode JSONL, and mocked RPC readiness/compaction boundaries. At this instrumentation stage the new timing fields had not been validated by another paid end-to-end model run. The later completed [timed DEV8 run](PI_DEV8_TIMED.md) records that measurement; its results are not retroactively added to the earlier run.

## Subsequent worker implementation

The synchronous-index descriptions above document the measured baseline. The indexed benchmark adapter now has a real session worker with configurable conversational-cycle batching; lifecycle, foreground/background boundaries and new measurements are in [BACKGROUND_INDEX.md](BACKGROUND_INDEX.md). The historical timing/DEV8 artifacts were not relabeled as worker results.
