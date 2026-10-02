# Production session worker and batched pre-tokenization

The production entry `src/index.ts` → `src/recall-extension.ts` now uses the session worker for automatic locators and `history_recall`. `history_grep` and `history_expand` retain their scan semantics. Search scope, ranking, snippets, pagination and rendering budgets remain byte-identical to the shared scan implementation. The experimental executable copies were removed; benchmark adapters import `src/`. Completed benchmark artifacts and the historical measurements below are unchanged, not results of this production cutover. No model run was repeated.

## Lifecycle and cadence

One persistent Node worker per extension instance/session, rather than a process per turn. The installed SDK **1.0.0** types and dispatch implementation were checked, replacing the prototype's Pi 0.99.1 assumptions:

- `session_start`: reasons `startup`, `reload`, `new`, `resume`, `fork`; read project configuration, clear stale callbacks/state, defer and coalesce prewarm
- `message_end` for a user message + `agent_end`: count one completed conversational cycle. In SDK 1.0.0 `message_end` runs **before** `appendMessage`, so it only sets the pending-user flag; no branch extraction here. `agent_end` has `messages`, not an independent error field. The last assistant's aborted/error stop reason prevents a user completion. Multiple user messages consumed in one completion count as one cycle
- Pre-tokenize when **10 completed user cycles OR 10 completed tool rounds** are reached. Configure independently with `PI_RECALL_PREINDEX_TURNS` (default10) and `PI_RECALL_PREINDEX_TOOL_ROUNDS` (default10); each accepts integers1–100. The tool condition fires from `turn_end` during a long task, without waiting for `agent_end`.
- `session_compact`: flush outstanding source additions and update which entries are eligible for search
- `session_tree`: cancel the old generation and rebuild for the current branch
- `session_shutdown`: cancel pending callbacks/requests and await worker termination; SDK 1.0.0 awaits this hook for quit, reload and new/resume/fork replacement, before invalidating/disposing the old runtime. No cross-session cache

A tool round is one completed assistant→tool batch with at least one result, regardless of parallel tool-call count. Completed error results count because the batch ran; empty batches and aborted/error assistant turns do not. SDK 1.0.0 `turn_end` is a persisted boundary with `messageEntryId`, `toolResultEntryIds` and `outcome`; assistant entry IDs suppress recent duplicate notifications. Both threshold counters reset when a batch callback is actually scheduled, while the current user-cycle pending flag stays intact. Tool rounds never fabricate user completions. `session_tree` is dispatched after branch restoration; `session_compact` is a post-compaction notification, not permission to take over native compaction.

No full branch scan on each ordinary completion: counting is cheap and the branch getter is called only when a scheduled batch is due. Multiple nearby events coalesce into one callback. Query-time branch validation remains necessary for correctness. No arbitrary text-size trigger was added; turn cadence is the explicit configurable trigger.

## Search correctness

The main thread retains an immutable raw branch-reference snapshot, including `context_edit` entries, and reuses its effective message projection until that snapshot changes. Both compacted and preindexed live entries use the shared branch-effective projection: latest replacements win and omissions disappear, including edits appended after compaction. Boundary selection uses raw ids before applying omissions, so omitting `firstKeptEntryId` cannot expose live messages. Worker payloads contain only id/date/role, source position, and searchable user/assistant text plus tool-call names/arguments. Tool-result bodies, thinking, images, custom/summary contents and whole JSONL are never sent or retained by the worker.

Live text is tokenized in the worker, but **does not enter search candidates or eligible-corpus document frequency/N**. At compaction, cached tokens for newly eligible entries activate without re-tokenizing the entire history. Eligible token caches are released after their postings are installed. Original ids/dates/order and shared output formatters are preserved; fake worker boundary metadata never appears in returned results.

During a live-only pre-index batch, queries can use the previous valid eligible index because its searchable corpus is unchanged. A newly scheduled live prewarm waits for in-flight foreground lookups instead of cancelling their cold generation. When newly compacted entries become eligible, queries await the needed generation rather than returning incomplete/stale evidence. First cold queries can still wait for readiness; prewarming reduces that wait only when it completes before the request. There is no promise that background work removes latency.

Generation IDs reject stale responses. Prefix changes, branch/reset, duplicate-id changes or shutdown cancel obsolete work. Worker termination completes before a replacement starts. Startup/request errors or unexpected exit switch to the **shared synchronous scan**, without an automatic restart loop. Fallback preserves scope, exact output and pagination; an explicit lifecycle reset can start a new worker. No result from another branch is returned.

Edited projections invalidate stale worker content through generation rebuilds, including cached live tokens before promotion. Branch restoration reprojects even when raw message identities are unchanged. Repeated queries on an unchanged edited branch share preparation rather than repeatedly cancelling it because replacements are fresh clones. This uses whole-branch reference checks and coarse rebuilds, not per-entry invalidation hooks. Offline parity coverage includes production context/manual pages, context edits, branch changes and append-only compaction that activates live token caches without re-tokenizing them.

## Blocking and memory boundaries

Heavy tokenization, postings, candidate search, dedup/ranking and rendering run in a real worker thread. It is not a synchronous callback relabeled as background.

Main-thread costs remain: branch selection/reference validation, searchable-text extraction/canonical tool-argument serialization, structured-clone submission and result delivery. Transfer batches target at most 32 entries / 64Ki UTF-16 units; large strings transfer in 64Ki chunks. Work yields between batches. Fixed entry/character limits avoid reading scheduling clocks when timing is disabled. A single unusually large/complex tool-argument object can still block during extraction; no silent truncation is used. Synchronous fallback scans/ranks on the main thread and can block. This is reduced blocking, not a hard real-time guarantee.

Worker memory includes a separate searchable-text copy, postings, and cached tokens for uncompressed entries. This is necessary isolation overhead and grows with the current branch. It does not duplicate raw tool results or entire session files. Only one active worker/generation is used per adapter; queued updates coalesce. Process RSS includes all worker isolates; worker heap is reported separately and must not be called worker-only RSS.

## Pi loading and package boundary

SDK 1.0.0 `core/extensions/loader.js` uses jiti with `moduleCache: false` and host SDK/typebox aliases. jiti's import-meta transform uses the original source filename; the coordinator resolves `./index-worker.mjs` from that source location (`__filename` under jiti, `import.meta.url` under native ESM), never from cwd or a transpiler-cache directory.

All worker code ships in `src/`, already included by npm `files`. The worker's entire runtime dependency graph is native `.mjs`: `history.mjs`, `locator.mjs`, `timing.mjs` and `inverted-index.mjs`. Main-thread scans and worker queries share these single implementations. No runtime TypeScript stripping, custom module loader, host aliases or warning suppression is used, including when installed under `node_modules`. The three migrated shared modules retain type checking through JSDoc and `@ts-check`; `allowJs` remains necessary for TypeScript entrypoints to consume their types, not to transform worker code.

The isolated SDK check copies only `src/` and the manifest into both a standalone directory and a `node_modules/pi-context-recall` installation layout. With timing both off and on, package-directory, public-entry and alternate-entry loads must complete startup, queries and awaited shutdown with **empty child-process stderr**. Enabled timing additionally requires real `worker_thread` query spans and no fallback marks. Child processes run without experimental flags or inherited warning suppression. This is an offline extension-loader check, not a live model/UI benchmark.


## Timing and validation

Timing is disabled unless `PI_RECALL_TIMING_FILE` is set. Enabled traces contain `background_prepare`, `worker_post_message`, per-operation `worker_roundtrip_*` and nested `worker_*` spans, `live_or_eligible_tokenization`, `postings_activation`, lexical query/ranking/rendering stages and `critical_path_index_wait`. Worker spans are transferred with globally distinct IDs and main-thread parent links; execution is `worker_thread`. `preindex_scheduled` records trigger and both counters; maintenance marks record kind, entry count and thread. Foreground waiting and background walltime overlap and must not be added together. See [TIMING.md](TIMING.md).

`node benchmark/benchmark-background.mjs` is an explicitly authorized offline comparison tool. The already-saved three-repeat comparison used the real 577d4d32 history, alternating isolated processes, identical output hashes, a 5ms main-event-loop heartbeat and separate cold/warm/update/live-pretokenization/activation measurements. Its frozen JSON remains [background-results.json](../benchmark/background-results.json); the following numbers describe that historical run, not this cutover.

Current tests cover exact scan/worker auto/manual parity, pagination, live-ineligible DF/N isolation, cached-token activation, queries during live batches, cold-query/prewarm races, duplicate ids, Unicode transfer, tool-result exclusion, cancellation/fork/disposal, startup failure/exit fallback, cadence/coalescing, timing-off clock isolation and timing-on worker parent spans. Real Pi model-loop testing was not run for the production migration. The earlier DEV8 used the synchronous indexed adapter; the later [timed DEV8 run](PI_DEV8_TIMED.md) used the experimental worker and remains a separate small-sample measurement.

## Historical measured result (offline, one real history)

Medians from three fresh-process repeats; warm values pool10 queries per repeat. Event-loop figures are median **maximum observed lag** per operation with a5ms heartbeat, not a UI frame-rate or p95 guarantee.

| Operation | Synchronous wall ms | Worker wall ms | Synchronous main-loop lag ms | Worker main-loop lag ms |
|---|---:|---:|---:|---:|
| Cold build + auto query | 1,236.4 | 1,629.9 | 1,237.0 | 33.3 |
| Warm auto query | 37.9 | 44.8 | 38.2 | 1.8 |
| Incremental eligible update + query | 201.4 | 295.3 | 203.5 | 2.2 |

Worker live-batch preindex:286.2ms wall,10.3ms maximum main-loop lag; subsequent compaction eligibility activation/query:50.9ms wall,3.5ms lag. These overlap-capable maintenance costs are reported separately and are not subtracted from foreground latency. Warm manual page median:67.0ms synchronous versus81.6ms worker.

Cold readiness became slower, while long main-thread stalls dropped sharply. Background prewarming can move that readiness delay before the user request; it does not eliminate the work. Session JSONL read/parse remains on the main thread in this local harness (roughly65–71ms maximum lag) and is shown separately, not hidden in an indexing speedup.

Main extraction during cold build:5.5ms summed; median per-repeat maximum postMessage synchronous submission:2.7ms; worker-online startup milestone126.9ms. Submission is not the whole transfer: worker roundtrip includes worker processing, queue/dispatch and transfer, without pretending those can be isolated by subtraction.

Memory after cold index, same source in each isolated process: process RSS143.7MiB synchronous versus232.9MiB worker; main retained heap42.6 versus18.9MiB, plus61.7MiB observed worker heap. Worker heap is sampled before an explicit worker GC, unlike the main post-GC sample; do not directly add them as matched retained-memory measures. Process peak RSS in raw results includes later auxiliary indexes used by the incremental/preindex checks. The worker buys responsiveness at additional total memory and readiness cost.

All auto/manual/update output hashes match across both arms and all repetitions. Latest verification: typecheck +54 Node tests,2 Python regressions, project skill validation, diff check, and offline Pi0.99.1 extension load/model-list check. No new model inference, commit or push.

## Cadence reference

These are index-preparation triggers, not a claim of equivalence to Hermes memory nudges or end-of-turn skill review. Compaction remains an independent eligibility/flush trigger, so reaching a tool threshold is not required for correctness. The cadence and production migration are validated offline; prior latency artifacts were not rerun or relabeled.


## Project configuration

This is an extension-owned file, **not** an added Pi-core settings field: `<Pi session cwd>/.pi/pi-recall.json`. Use the session working directory, not necessarily the plugin installation directory. For the existing benchmark snapshots, the stored cwd is `lme-bench/runs/cwd`; normal project use points to that project's `.pi` directory. No settings file was written for the user.

```json
{
  "preindex": {
    "userCycles": 10,
    "toolRounds": 10
  }
}
```

Copy/adapt [pi-recall.config.example.json](../benchmark/experimental/pi-recall.config.example.json). Fields are independent integers1–100. Precedence per field: valid `PI_RECALL_PREINDEX_TURNS` / `PI_RECALL_PREINDEX_TOOL_ROUNDS` environment override → valid file field →10 default. Invalid environment values warn and fall back to file/default. Invalid fields warn and use defaults; unreadable/malformed/oversized files warn and are ignored. Missing file is normal and silent; unknown fields are ignored with a warning. File contents and bad values are never dumped into warnings.

Read once per `session_start` (including startup/resume/reload), using the documented extension context cwd. File edits take effect at the next such lifecycle event, not mid-tool. No background watcher or per-tool filesystem read.

Either OR trigger schedules a batch and resets **both counters together**. Further user/tool activity while that callback is queued or its worker is running belongs to the next batch; coalescing does not reset it again or lose newer source additions. The current in-progress user cycle stays pending and can complete normally after a tool-triggered batch. Session reset/fork clears all cadence state.
