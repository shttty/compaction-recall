# history_recall prompt and lenient surfaces (prototype, 2026-10-09)

Branch `proto/recall-prompt-20261009` from main `203ec4b`. Recall-only evaluation: no answering or judging. Inputs, scripts,
per-run rows and the full report stay in the external local evaluation data (`compaction-recall-evaldata`,
`lme16/para-zh/REPORT.md`); figures below are its summaries.

## Changes

1. `471a7ed` — a concept or exclusion surface that yields no searchable terms is ignored with a warning instead of voiding
   the call; `EMPTY_ANALYSIS` remains when no positive surface is left. Groups accept 1..8 alternatives (compiler limit,
   tool schema, description, `PLUGIN.md`).
2. `6699140` — a strategy paragraph appended to the `history_recall` description: messages were worded before the
   question; one group per topic with short alternatives (names, synonyms, broader/narrower terms, Chinese and English
   forms); drop non-identifying words; `match=any` by default; two or three differently worded calls in parallel. It
   states no tokenizer rule.

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

| set | model | main `203ec4b` | this branch |
|---|---|---|---|
| paraphrases (48) | gpt-6-luna medium, 2–4 runs | 33.0 (round 1: 21.5) | 41.5 (round 1: 36.3) |
| held-out English (64) | gpt-6-luna medium, 2 runs | 56.5 (round 1: 52.0) | 60.0 (round 1: 59.0) |
| paraphrases (48) | gpt-6.1-sol high, 1 run | 48 (round 1: 39) | 47 (round 1: 41) |
| held-out English (64) | gpt-6.1-sol high, 1 run | 63 (round 1: 61) | 64 (round 1: 63) |

Rejected calls fell from 34.5 / 11 (luna) and 46 / 12 (sol) to 0–2.5 and 1; mean rounds fell on every set. Variants
tried and not kept: strategy prepended (equal), with a worked example (equal, more calls), trimmed mechanics text (−3 to
−4). With the strategy paragraph, adding a bge-m3 vector channel to model searches and locators recovered only 0–2 more
paraphrases (4–5 under the current description).

## Limits and open points

- One model family stands in for the agent; luna runs vary by ±3–5 of 48; sol was run once per arm and nearly saturates.
- Paraphrases were model-written against the gold text and not reviewed; three are too vague to identify a target.
- “Seen in a page” is not an answer; no `history_expand` / `history_grep` in the loop.
- Remaining rejections are groups over 8 alternatives (English synonym lists); cutting with a warning would remove them.
- Whether `reasoning_effort=high` changes gpt-6.1-sol's reasoning on this endpoint is not established.
