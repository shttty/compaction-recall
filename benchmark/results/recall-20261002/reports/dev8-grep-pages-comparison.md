# DEV8 grep-pages candidate comparison — descriptive only

Same frozen eight questions and actual shared snapshot bytes; 24 audited explicit verdicts per run.

| Candidate | Native | Grep | Production | Production mean seconds | Production answer tokens incl. cache |
|---|---:|---:|---:|---:|---:|
| f5715d19 | 0/8 | 5/8 | 7/8 | 32.3 | 7004658 |
| 7d1980b8 | 0/8 | 6/8 | 8/8 | 35.8 | 7594443 |
| 5acf40ef | 0/8 | 4/8 | 7/8 | 37.0 | 7601487 |
| 8149e1f6 | 0/8 | 3/8 | 8/8 | 33.0 | 6725715 |

Latest 8149e1f6 includes earlier expand-pagination and coverage ancestry; this is not a clean causal ablation of grep pagination. Production is 8/8 like the earlier expand-paging run, so no extra DEV8 accuracy gain is established. Grep is 3/8; four wrong grep answers made no tool calls. Its four actual history_grep calls all used offset=0; production made no history_grep calls. No continuation-page requests were observed, so this run does not validate benefits from traversing additional grep pages.

Answer timing/token usage are descriptive observations, not statistically demonstrated speed/cost gains. Tokens include SDK-normalized uncached input, output and cache counters; compression/judging are excluded. Provider TTFT and billing are unknown. All previous audit-tracked bytes and latest actual sessions were rehashed unchanged; completed resume makes zero provider calls.

Evidence: parent-dev8-capacity-base-audit.json, parent-dev8-capacity-paging-audit.json, parent-dev8-coverage-audit.json, parent-dev8-grep-pages-audit.json, parent-dev8-grep-pages-session-audit.json. HARD8 results for this candidate are not yet available. No merge/profile installation authorized.
