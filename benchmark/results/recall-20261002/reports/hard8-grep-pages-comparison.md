# HARD8 grep-pages candidate: audited descriptive comparison

Same frozen eight source-projected questions and actual snapshot bytes. Each run has 24 durable explicit verdicts; completed resume made zero new provider calls. Latest candidate is an archive, not a live worktree. This is not a clean isolated ablation of the grep change: candidate includes earlier expand/coverage changes.

| Candidate | Native | Grep | Production | Production mean seconds | Production answer tokens incl. cache |
|---|---:|---:|---:|---:|---:|
| f5715d19 | 1/8 | 1/8 | 3/8 | 88.0 | 16073204 |
| 7d1980b8 | 0/8 | 1/8 | 2/8 | 103.1 | 16959766 |
| 8149e1f6 | 0/8 | 1/8 | 3/8 | 94.7 | 16443912 |

Production is 3/8, equal in aggregate to the original baseline, with one newly correct and one newly incorrect question: {"2ce6a0f2": ["no", "yes"], "gpt4_731e37d7": ["yes", "no"]}. Mean answer time is 6.7s higher than base in this observation; answer usage incl. cache is 370708 higher. No stable improvement or causal regression established. SDK normalized usage only; compression/judging excluded; billing and provider TTFT remain unknown.

## Actual pagination, not inferred from tool names

Seventeen grep calls total (7 control, 10 production); four requested offset>0. One control query genuinely continued unchanged pattern with offset30 and returned30 entries. Three requests changed pattern while carrying offset; these are not continuation proof. The production request changed pattern, passed offset30, and received zero entries for a query with only4 matching entries. This is observed caller misuse, not a backend provider failure; that question was nevertheless graded correct. No expand request used offset>0. Six wrong control answers made no tool calls.

## Failure observations; not established retrieval causes

All five wrong production answers are aggregation/count/sum questions. Finals omit required items or broaden counting predicates; the project-count final explicitly includes projects merely worked on although it acknowledges those were not stated to be led. Another final excludes a dated event when computing a total; this audit has not independently adjudicated source-time ambiguity. Exact traces and official gold remain preserved; no candidate change, benchmark-keyword rule or custom regrading was made from them. Official yes/no grading accepts some conditional answers, so a yes does not imply an exhaustive, unambiguous evidence set.

## Integrity and disposition

Parent ledger audit plus supplementary actual-session audit both verified24records: exact immutable seed prefix, exact question and final answer, model/provider/API, model-call count, summed new usage, tool-call/result IDs/names, all runtime pin fields. Further guarded resume0, all current session/ledger/snapshot bytes unchanged. All previous DEV8/HARD8 baseline/paging/coverage/pilot audit-tracked bytes and previous current-candidate actual sessions rehashed unchanged. Service completed once, exit0, runtime11min23.329s, peak724.1M, swap0. No48run/merge/push/install/deploy/publish. Candidate remains isolated-only; no promotion approved.

Evidence: parent-hard8-grep-pages-audit.json SHA153b90b1a2be8f255397ddd2097a43192abf749763ca6869c650ca438e814a4f; parent-hard8-grep-pages-session-audit.json; hard8-grep-pages-comparison.json. Baselines: parent-hard8-base-audit.json, parent-hard8-paging-audit.json.
