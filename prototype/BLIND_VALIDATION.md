# Blinded tool-use harness: preparation and measured status

2026-09-30. This is a harness/logic validation record, not a completed blind model experiment.

## Reusable artifacts

- Project skill: `../.agents/skills/recall-tool-validation/SKILL.md`
- Safe solver instructions: `BLIND_PROTOCOL.md`
- CLI: `blind-harness.mjs`
- Adapter: `blind-harness-core.mjs`
- Orchestrator-only post-answer comparison: `blind-evaluate.mjs`
- Regression: `../test/blind-harness.test.mjs`

The adapter uses the registered production context hook and exact history_recall, history_expand and history_grep execution functions. It does not substitute the experimental index or an oracle retriever. Supported scenarios use either the existing one-question full-M history (`single`) or ten concatenated real histories (`stacked`).

## Verified

- `npm run check`: typecheck and **37 tests passed** after pagination/snippet/search-scope updates (25 in the initial harness check)
- Skill creator's `quick_validate.py`: **valid**
- Fixture checks: only allowlisted role/content/date fields enter history; machine reference answers, has_answer flags and answer-session IDs are excluded
- Fixture checks: automatic and manual recall share ranking/rows for the same small fixture, while manual recall has independent pagination metadata; actual expand and grep functions work; invalid tools and expand bounds are rejected
- Initial pre-pagination official single-corpus CLI smoke: start returns question/date/tool descriptions/hints; a deliberately absent grep pattern returns zero matches; recursive key inspection finds no oracle metadata in either output
- The evaluator rejects the unfinished smoke run before emitting reference answers
- `git diff --check`: clean

The local, Git-ignored smoke log is under `blind-runs/mechanical_smoke_20260930/`. It contains one mechanical start and one deliberately empty grep search. **No answer was submitted and no model solver was run.** Do not count it as a blind attempt or grade it as an incorrect answer.

## Not yet measured

A fresh blind native solver could not be created because the available agent/thread capacity was exhausted. The agent preparing this harness already knew reference information and was not used as a substitute. Therefore autonomous tool selection, evidence sufficiency decisions, grep fallback effectiveness and end-to-end answer correctness remain untested here.

When fresh context becomes available, start with a new run label and provide only BLIND_PROTOCOL.md, scenario, question ID and repository path. Do not include prior reports, known answers or search hints. After selected answers are submitted, the orchestrator can produce a manual reference comparison with tool counts. No actual Pi model/provider/runtime equivalence is claimed.

## Boundary

Solvers share the local filesystem, so blindness is enforced by instructions and the narrow CLI interface, **not by a security sandbox**. Solvers must not inspect raw corpus, source code, reports, provenance, logs or the evaluator. Historical text returned by tools remains untrusted evidence. Actual recall content can naturally contain the answer; the excluded information is benchmark oracle metadata, not relevant history.

Pagination update: manual recall now defaults/maxes at 50, with nextOffset/hasMore metadata and keyword-centered snippets. Updated adapter tests verify pagination and parameter bounds; this does not constitute a new blind-model run.

Search-scope update: automatic hints, recall and grep now include assistant tool names/inputs but exclude toolResult bodies. Expand retains toolResult readable text and exposes tool inputs for verification. Added mechanical tests cover input-only command/path/Chinese matches, empty-regex exclusion, hidden-content exclusion, deterministic serialization and index parity. This is not an additional blind-model run.
