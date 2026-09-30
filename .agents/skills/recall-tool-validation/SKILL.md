---
name: recall-tool-validation
description: Validate pi-recall logic and recall/expand/grep tool use with offline fixtures or a fresh blind native solver on existing real benchmark histories. Use for project-level retrieval workflow checks, not claims about model accuracy or actual Pi runtime evaluation.
---

# Recall tool validation

Work from the pi-recall repository root. Preserve its current branch and uncommitted work. Do not install into a profile, switch production retrieval, download data, call external model APIs, or run a larger paid benchmark merely because this skill was invoked.

## Choose the requested stage

- **Mechanical logic/tool checks:** run `npm run check`. The [blind adapter regression](../../../test/blind-harness.test.mjs) checks oracle-field removal and calls the actual registered context hook and tools. Passing fixtures does not establish blind model behavior.
- **Blind tool-use simulation:** only when the caller requested it and a fresh native solver can be created. Use `single` for the existing one-question full-M history, or `stacked` for the existing ten-history corpus. Existing inputs are `prototype/selected.download.json` and `prototype/stacked.download.json`; if missing, report the missing input rather than automatically downloading it.
- **Evaluation:** only after the requested solver answers have been submitted. Review evidence, tool choices and final answers separately from retrieval speed.

Native subagents here simulate reasoning and tool use. They do not reproduce the actual Pi model/provider/context runtime. Local filesystem blindness is an instruction/interface boundary, not a secure sandbox; disclose that limitation.

## Orchestrator / solver separation

The orchestrator may prepare and inspect the harness. An agent that has seen reference answers, gold labels, benchmark reports or prior solutions must not serve as a blind solver.

Create fresh solver context without inherited conversation (`fork_turns: none` when supported). Prefer a fresh solver per question, so earlier answers do not leak into later cases. Give it only:

1. Repository path, scenario, a new run label and assigned question ID
2. The [solver protocol](../../../prototype/BLIND_PROTOCOL.md), which contains no reference answers
3. The commands it may execute

Do not supply suspected answer strings, evidence locations, past scores or successful search terms. If a fresh context cannot be created, stop the model stage and report **mechanical checks complete; blind solver not run**. Do not substitute yourself or reuse a contaminated worker.

## Harness and commands

The [CLI](../../../prototype/blind-harness.mjs) wraps the [adapter](../../../prototype/blind-harness-core.mjs), which invokes the real production `context` hook and `history_recall`, `history_expand`, `history_grep` execute functions. No oracle-aware retriever or replacement tool is allowed.

Example for one assigned question, with a unique run label:

```sh
node prototype/blind-harness.mjs single start 577d4d32 RUN
node prototype/blind-harness.mjs single tool 577d4d32 RUN history_recall '{"query":"keywords chosen by the solver"}'
node prototype/blind-harness.mjs single tool 577d4d32 RUN history_expand '{"id":"returned-entry-id","before":0,"after":0}'
node prototype/blind-harness.mjs single tool 577d4d32 RUN history_grep '{"pattern":"solver-chosen fallback pattern"}'
node prototype/blind-harness.mjs single answer 577d4d32 RUN '{"answer":"solver answer","evidenceIds":[],"uncertainty":"if any"}'
```

Replace `single` with `stacked` to query all ten artificial histories. The stacked IDs are 577d4d32, 778164c6, 51b23612, ceb54acb, 3d86fd0a, 15745da0, gpt4_65aabe59, 982b5123, e47becba, 118b2229. Question wording and question date come from `start`; neither caller nor solver should rewrite the actual question. The solver may reformulate tool queries.

The workflow is automatic hints → recall as needed → expand to verify → grep when evidence remains insufficient. This is guidance, not a requirement to invoke every tool. Automatic useful IDs may be expanded immediately. Record abstention/uncertainty rather than forcing an answer. Set a bounded per-question tool/time budget appropriate to the requested run; stop and report exhaustion without treating it as evidence of absence.

## Evaluate after answers, without backflow

Only the orchestrator may run the [evaluator](../../../prototype/blind-evaluate.mjs), after every selected answer is submitted:

```sh
node prototype/blind-evaluate.mjs RUN 577d4d32
# Omit IDs only when all ten have submitted answers.
```

The evaluator refuses unfinished cases and produces a reference/solver comparison plus recall/expand/grep counts. It does not automatically judge semantic correctness. Manually review supported answer content, evidence IDs, date handling, fallback use and unjustified assumptions. Do not send gold feedback back into the same run and call it blind.

Logs are in `prototype/blind-runs/RUN/`. Report completed/skipped/blocked stages, scenario and sample size, tool counts, observed failure modes, and limitations. Distinguish mechanical checks, actual blind solver traces, manual reference comparison and genuine Pi/provider evaluation. Do not claim an unrun stage or general model-quality improvement.
