# Session worker and batched pre-indexing prototype

This replaces the **experimental Pi indexed-arm adapter**, not the production scan extension. It does not change search scope, ranking, snippets, pagination, or the completed DEV8 results. No paid model run was repeated for this change.

## Lifecycle and cadence

One persistent Node worker per indexed adapter/session, rather than a process per turn. Actual Pi0.99.1 hooks verified in installed SDK:

- `session_start`: defer and coalesce initial/resume prewarm
- `message_end` for a user message + `agent_end`: count one completed conversational cycle. Model/tool turns do not increment the user-cycle counter; they have a separate tool-round counter. Aborted/error completions do not advance it. Multiple user messages consumed in one agent completion count as one cycle
- Pre-tokenize when **10 completed user cycles OR 10 completed tool rounds** are reached. Configure independently with `PI_RECALL_PREINDEX_TURNS` (default10) and `PI_RECALL_PREINDEX_TOOL_ROUNDS` (default10); each accepts integers1–100. The tool condition fires from `turn_end` during a long task, without waiting for `agent_end`.
- `session_compact`: flush outstanding source additions and update which entries are eligible for search
- `session_tree`: cancel the old generation and rebuild for the current branch
- `session_shutdown`: cancel pending callbacks/requests and terminate the worker; no cross-session cache

A tool round is one completed assistant→tool batch with at least one result, regardless of parallel tool-call count. Completed error results count because the batch ran; empty batches and aborted/error assistant turns do not. SDK `messageEntryId` suppresses recent duplicate notifications. Both threshold counters reset when a batch callback is actually scheduled, while the current user-cycle pending flag stays intact. The two counters are independent: tool rounds never fabricate user completions.

No full branch scan on each ordinary completion: counting is cheap and the branch getter is called only when a scheduled batch is due. Multiple nearby events coalesce into one callback. Query-time branch validation remains necessary for correctness. No arbitrary text-size trigger was added; turn cadence is the explicit configurable trigger.

## Search correctness

The main thread retains an immutable raw branch-reference snapshot, including `context_edit` entries, and reuses its effective message projection until that snapshot changes. Both compacted and preindexed live entries use the shared branch-effective projection: latest replacements win and omissions disappear, including edits appended after compaction. Boundary selection uses raw ids before applying omissions, so omitting `firstKeptEntryId` cannot expose live messages. Worker payloads contain only id/date/role, source position, and searchable user/assistant text plus tool-call names/arguments. Tool-result bodies, thinking, images, custom/summary contents and whole JSONL are never sent or retained by the worker.

Live text is tokenized in the worker, but **does not enter search candidates or eligible-corpus document frequency/N**. At compaction, cached tokens for newly eligible entries activate without re-tokenizing the entire history. Eligible token caches are released after their postings are installed. Original ids/dates/order and shared output formatters are preserved; fake worker boundary metadata never appears in returned results.

During a live-only pre-index batch, queries can use the previous valid eligible index because its searchable corpus is unchanged. When newly compacted entries become eligible, queries await that generation rather than returning incomplete/stale evidence. First cold queries can still wait for readiness; prewarming reduces that wait only when it actually completes before the request. There is no promise that background work removes latency.

Generation IDs reject stale responses. Prefix changes, fork/reset, duplicate-id changes or shutdown cancel obsolete work. Worker termination completes before a replacement starts. Errors/exit switch the generation to a cooperative-yielding exact fallback, without an automatic restart loop. Fallback preserves scope and pagination; a later session reset can start a new worker. No result from another branch is returned.

Edited projections invalidate stale worker/fallback content through the existing generation rebuild path, including cached live tokens before promotion. Branch restoration reprojects even when raw message identities are unchanged. Repeated queries on an unchanged edited branch share the same preparation rather than repeatedly cancelling it because replacement entries are fresh clones. This deliberately uses whole-branch reference checks and coarse rebuilds, not per-entry invalidation hooks. Regression command: `node --test test/prototype-context-edit.test.mjs test/background-index.test.mjs test/prototype.test.mjs`.

## Blocking and memory boundaries

Heavy tokenization, postings, candidate search, dedup/ranking and rendering run in a real worker thread. It is not a synchronous callback relabeled as background.

Main-thread costs remain: branch selection/reference validation, searchable-text extraction/canonical tool-argument serialization, structured-clone submission and result delivery. Transfer batches target at most32 entries /64Ki UTF-16 units; large strings transfer in64Ki chunks. Work yields between batches. A single unusually large/complex tool-argument object can still block during its extraction; no silent truncation is used. Fallback yields between documents, but one unusually large document or final fallback ranking can still block. This is reduced blocking, not a hard real-time guarantee.

Worker memory includes a separate searchable-text copy, postings, and cached tokens for uncompressed entries. This is necessary isolation overhead and grows with the current branch. It does not duplicate raw tool results or entire session files. Only one active worker/generation is used per adapter; queued updates coalesce. Process RSS includes all worker isolates; worker heap is reported separately and must not be called worker-only RSS.

## Timing and validation

`background_index_ready` reports background readiness wall time, main extraction time and worker heap. `worker_post_message` measures synchronous clone/submission time; `worker_operation` separates worker execution from roundtrip wait and includes nested lexical-stage spans. `critical_path_index_wait` reports actual request waiting, not CPU time. Background walltime and foreground waiting overlap and must not be added together. Existing synchronous timing smoke remains a historical baseline.

`node benchmark/benchmark-background.mjs` runs an offline comparison on the real saved577d4d32 history: three isolated processes per arm, alternating order, identical outputs, 5ms main-event-loop heartbeat, separate read/parse, cold lookup,10 warm auto lookups,5 manual pages, incremental update, live preindex and eligibility activation. JSON contains all repeats, stage timing, source hashes and memory: [background-results.json](../benchmark/background-results.json). No model or credential access.

Tests cover exact scan/worker auto/manual parity, pagination, live-ineligible DF isolation, unchanged-index queries during live batches, incremental boundaries, duplicate ids, Unicode transfer, no tool-result leakage, cancellation/fork/disposal, startup failure/unexpected exit fallback, cadence and coalescing. Real Pi model-loop testing was unrun at this implementation stage; the earlier DEV8 used the synchronous indexed adapter. The later completed [timed DEV8 run](PI_DEV8_TIMED.md) used the worker and remains a separate small-sample measurement, not a rerun of these offline timings.

## Measured result (offline, one real history)

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

These are this prototype’s index-preparation triggers, not a claim of equivalence to Hermes memory nudges or end-of-turn skill review. Compaction remains an independent eligibility/flush trigger, so reaching a tool threshold is not required for compaction correctness. The tool-round addition was validated offline; prior latency artifacts were not rerun or relabeled.


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
