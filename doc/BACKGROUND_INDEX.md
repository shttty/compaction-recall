# SQLite session worker (0.1)

`src/index.ts` → `src/recall-extension.ts` selects the released SQLite worker engine in full mode. lite registers only grep/expand and does not create a worker. Current configuration/tool semantics are authoritative in [PLUGIN.md](PLUGIN.md).

## Source and query path

- Main thread: project the current branch's context edits and raw compaction boundary; send only searchable user/assistant text and assistant tool-call names/arguments, ids, role/date and source positions through the existing batched/large-entry protocol.
- Worker: `src/index-worker.mjs` loads `src/default-worker-engine.mjs`; its `.mjs` dependency chain stays wholly in `src` plus installed production `node_modules`. No TypeScript loader or runtime benchmark/prototype import.
- Engine: filter `sourcePosition < eligibleCount`; compare the eligible projection; build/rebuild `DatabaseSync(':memory:')` only when it changes. The released strategy is English Porter plus raw Han bigrams; jieba dictionary terms enter only `han_rank`, not FTS candidate terms.
- Query: unchanged author concept compiler and span-completeness checks → native MATCH/BM25/full-content representatives → SQL positive-long-surface count/time order → LIMIT/OFFSET → current-page snippets and shared renderer. Partial loss gives a warning with ordinary FTS results; zero-token surfaces retain EMPTY_ANALYSIS.
- Automatic hints retain the measured lexical query terms and weighted gate280, selecting top five before the display budget. Pure Han bigram automatic terms generally have no long-surface ranking bonus. Manual recall uses concepts/match/exclude and stable nextOffset pages.

SQLite uses in-memory storage and `temp_store=MEMORY`, no persistent index/db/WAL/SHM. Native jieba loads only inside the worker when enabled. The parent captures autoGate/snippet/jieba at extension load; no environment/profile reads are added to worker queries.

## Lifecycle

One active worker per extension instance. `session_start`/`session_tree` cancel stale state, reset cadence using loaded values and coalesce prewarm; `session_compact` refreshes eligible history. Completed user cycles and completed tool batches independently trigger prewarm (default10 each). The public preindex configuration names remain; this SQLite engine does not have the old JS live-token/posting cache. Live records may be staged but do not enter FTS or eligible counts.

Queries wait for necessary maintenance. Live-only preparation of the same eligible corpus can serve the valid index; foreground requests are not cancelled just to prewarm. Generation checks reject obsolete branch results. Query/compiler/timeout errors preserve healthy worker state; a cooperative deadline discards late results, but synchronous native MATCH cannot be interrupted.

Transport/startup/worker failures propagate rather than selecting a different JS retrieval algorithm. A later explicit lifecycle reset can rebuild. Shutdown cancels pending callbacks/requests, invokes engine dispose and waits for worker termination; no cross-session cache.

## Diagnostics and verification

Optional timing is file-only (`COMPACTION_RECALL_TIMING_FILE`), default off. Memory samples are distinct process RSS/main heap/worker heap/external values, not additive index sizes; SQLite/jieba native allocations can appear mainly in RSS. Structured content trace is separately opt-in in the agent file; see [TIMING.md](TIMING.md).

Current offline regression coverage exercises concepts/warnings/zero-token, FTS scope, on/off SQL order before pages, gate/Porter behavior, lifecycle, lite and isolated SDK loading. Release preparation additionally verifies the real npm tarball in an independently installed layout; tests are not model-accuracy/performance evidence.

## Historical JS design and results

The pre-SQLite runtime and exact prior design document are retained in [benchmark/archive/js-runtime](../benchmark/archive/js-runtime/) and [its original BACKGROUND_INDEX.md](../benchmark/archive/js-runtime/original-docs/doc/BACKGROUND_INDEX.md). Old JS scan equivalence, live token DF/N caches, synchronous fallback and historical timings belong to that snapshot, not this SQLite implementation. Historical scripts/tests now explicitly reference the archived JS modules. Frozen measurement/result bytes were not rewritten or remeasured.
