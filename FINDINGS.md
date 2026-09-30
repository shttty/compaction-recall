# Recall spike findings (PROTOTYPE, 2026-09-29)

Question: keeping Pi's native compaction summary, do two raw-history tools recover what compaction lost?

Setup: lme-bench (sibling repo), LongMemEval_M, 48 questions (8 per type), ~1.1M tokens each,
fed in 4 chunks with 3 Pi native compactions. `pi-native` and `pi-recall` answer from the **same** compacted snapshot;
`pi-recall` only adds `history_grep` / `history_expand` (this directory) over entries compacted out of context.
Answer and compaction model clp/gpt-6-luna high; judge gpt-6-luna xhigh with the official prompts.

| | pi-native | pi-recall | OMP snapcompact (ref) |
|---|---|---|---|
| Total | 13/48 (27%) | **25/48 (52%)** | 16/48 (33%) |
| Evidence only in compacted chunks (30) | 3 | **15** | 6 |
| Evidence in raw last chunk (7) | 5 | 5 | 5 |

Paired: recall-only right 13, native-only right 1, exact McNemar p = 0.0018.

When the model searched it was usually right (14/18). The bottleneck is **not searching**: 30/48 answers made no
tool call, and 19 of those were wrong, all 8 preference questions included (the model answered from general knowledge),
plus several "not enough information" answers given without a single grep (e.g. d905b33f).

Verdict:
- Raw-history grep + expand is the main lever; build the index and these tools first.
- The next question is *triggering*: get relevant compacted history in front of the model without relying on it
  deciding to search (automatic recall at turn start, or summaries that carry searchable clues). DAG summaries are
  secondary until that is measured.
