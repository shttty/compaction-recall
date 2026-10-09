# history_recall prompt and lenient surfaces (2026-10-09)

Developed on `proto/recall-prompt-20261009` from main `203ec4b` and fast-forwarded to main. Recall-only evaluation: no
answering or judging. Inputs, scripts, per-run rows and the full report stay in the external local evaluation data
(`compaction-recall-evaldata`, `lme16/para-zh/REPORT.md`); figures below are its summaries.

## Changes

1. `471a7ed` — a concept or exclusion surface that yields no searchable terms is ignored with a warning instead of voiding
   the call; `EMPTY_ANALYSIS` remains when no positive surface is left. Groups accept 1..8 alternatives (compiler limit,
   tool schema, description, `PLUGIN.md`).
2. `6699140` — a strategy paragraph appended to the `history_recall` description: messages were worded before the
   question; one group per topic with short alternatives (names, synonyms, broader/narrower terms, Chinese and English
   forms); drop non-identifying words; `match=any` by default; two or three differently worded calls in parallel. It
   states no tokenizer rule.
3. `17d958b` — groups, alternatives and exclusions past their limits are ignored with a warning instead of rejecting
   the call. The count limits moved from the tool schema, which Pi validates with AJV before `execute`, into the
   description; `parseQuery` accepts an optional `clamped` collector and the worker reports the ignored items.

## Why

The current description is almost entirely mechanics. With it, a model's first query was worse than mechanical automatic
recall even on original wording (gpt-6-luna, 16 LME16 Chinese questions: gold session in top 10, 9 vs 16): half the calls
used `match=all`, surfaces were multi-term phrases, and generic words were included. 23–29 % of agent calls were
rejected outright — 77 % for a zero-term surface (a lone Han character, a pronoun) and 23 % for more than 4 alternatives.
Writing those limits into the prompt did not reduce rejections.

## Method

A model receives the question, the real tool description/schema from the checkout under test, and (as full mode does) the
automatic top-5 locators; each round it may issue up to 3 parallel `history_recall` calls and sees the plugin's real page
text or error; at most 3 rounds. Metric: a gold turn appeared in any page or locator the model saw (pages up to 50 rows),
overall and in round 1. Index: this checkout's `createIndex`/`queryPage` in a worker with jieba, documents = whole turns.
Tuning set: 48 Chinese paraphrases of the LME16 questions (gpt-6-luna-written, avoiding the gold wording). Validation:
the frozen English held-out set (64 LongMemEval_M questions, original wording, never used for tuning).

## Results (gold turn seen; mean over runs)

Over OpenAI-compatible `/chat/completions` (`17d958b`'s clamping not yet included):

| set | model | main `203ec4b` | this change |
|---|---|---|---|
| paraphrases (48) | gpt-6-luna medium, 2–4 runs | 33.0 (round 1: 21.5) | 41.5 (round 1: 36.3) |
| held-out English (64) | gpt-6-luna medium, 2 runs | 56.5 (round 1: 52.0) | 60.0 (round 1: 59.0) |
| paraphrases (48) | gpt-6.1-sol high, 1 run | 48 (round 1: 39) | 47 (round 1: 41) |
| held-out English (64) | gpt-6.1-sol high, 1 run | 63 (round 1: 61) | 64 (round 1: 63) |

Over Anthropic Messages, as production clp is configured (`api: anthropic-messages`; adaptive thinking with
`output_config.effort`), `203ec4b` vs `17d958b`:

| set | model | `203ec4b` | `17d958b` |
|---|---|---|---|
| paraphrases (48) | gpt-6-luna medium, 2 runs | 33.5 (round 1: 23.0) | 40.5 (round 1: 34.5) |
| held-out English (64) | gpt-6-luna medium, 2 runs | 58.0 (round 1: 52.0) | 61.0 (round 1: 59.0) |
| paraphrases (48) | gpt-6.1-sol high, 1 run | 46 (round 1: 34) | 46 (round 1: 43) |
| held-out English (64) | gpt-6.1-sol high, 1 run | 64 (round 1: 60) | 64 (round 1: 62) |

Rejected calls fell from 11–37 per set to 0–1, and mean rounds fell on every set. Variants tried and not kept: strategy
prepended (equal), with a worked example (equal, more calls), trimmed mechanics text (−3 to −4). With the strategy
paragraph, adding a bge-m3 vector channel to model searches and locators recovered only 0–2 more paraphrases (4–5
under the old description).

## End-to-end LME16 (answer + two strict judges), same day

Answer gpt-6-luna high, judges gpt-6-luna xhigh and gpt-6.1-sol medium, frozen native snapshots, workers 8. Scores
are strict correct of 16 (luna / sol). On 2026-10-09 the 2026-10-06 baselines were rerun with their frozen candidates,
configs and inputs (English exactly, runner `d63ef30` byte-identical to the original and Node v24.18.0; Chinese with the
closest committed runner, as 6 original runner files were never committed):

| set | 10-06 original | 10-09 rerun of the 10-06 candidate | 10-09 `ddc1752` |
|---|---|---|---|
| Chinese | 9 / 9 | 6 / 6 | 9 / 9 |
| English | 10 / 10 | 7 / 7 (HARD8 0 / 0) | 10 / 9 |

The exact English rerun lost three questions with unchanged code and inputs, so scores drift across days with the
provider's models; historical runs are not a valid yardstick. Compared on the same day, `ddc1752` answered three more
questions than the 10-06 candidate in each language under both judges. Each cell is a single run.

## Limits and open points

- One model family stands in for the agent; luna runs vary by ±3–5 of 48; sol was run once per arm and nearly saturates.
- Paraphrases were model-written against the gold text and not reviewed; three are too vague to identify a target.
- “Seen in a page” is not an answer; no `history_expand` / `history_grep` in the loop.
- The one rejection left after clamping is a call whose every surface had no searchable terms, which errors by design.
- gpt-6.1-sol thinks at every effort setting with little change on both protocols; its effort sensitivity is unmeasured.
