# DEV8: frozen baseline vs expand paging

Runner: `858ae2fe5729edf7067dc34d8f7bf902ab4423f4`; SDK1.0.0; requested answer Luna high, judge Luna xhigh.
Baseline plugin: `f5715d1901b6bedf19811030f18f3733eefb7bc4`. Paging plugin: `7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014`.

| Arm | Baseline correct | Paging correct | Baseline mean answer s | Paging mean answer s | Baseline answer tokens incl cache | Paging answer tokens incl cache |
|---|---:|---:|---:|---:|---:|---:|
| native | 0/8 | 0/8 | 12.6 | 14.4 | 2,221,118 | 2,221,273 |
| grep | 5/8 | 6/8 | 27.9 | 25.1 | 5,037,032 | 5,311,457 |
| production | 7/8 | 8/8 | 32.3 | 35.8 | 7,004,658 | 7,594,443 |

Both evaluations have24 answered/explicitly graded durable records, all8 questions accounted for. All three arms perquestion use the same actual snapshot bytes; paging reused all8 baseline snapshots and baseline artifact bytes remain unchanged. Both completed-run resumes were guarded with0new model/RPC/compression calls.

Paging production resolves982b5123 with history_recall +two history_expand calls; its real answer combines both separate evidence pieces. This is an observed single-run paired sample, not a stable causal/general accuracy claim. Model randomness, provider/cache conditions and extra model rounds can affect the result and timing. Cache differs substantially (especially native); no billing inference from total tokens.

Token totals are newly generated answer-assistant SDK usage including cacheRead/cacheWrite. They exclude judge/compression usage; compression provider consumption, provider TTFT and money cost remain unknown.

Machine evidence: parent-dev8-capacity-base-audit.json (SHA490adf20df104f27547d1c2e7d5cf25a513446e37cd38a4a9c54ab9989284234) andparent-dev8-capacity-paging-audit.json (SHA4ba85e055ef161ce70be4ac7a151b88cbfbd6a052c4ec5b9383494faf35b248a).

No main merge/push/profile install/publish. Coverage/budget candidate5acf40e has not been measured yet; exact-ref runner extension is frozen by3filehashes pending independent Standards/Spec reviewdeleg_b32daeba. HARD8 staysfrozen/disjoint and follows DEV8 candidate comparisons.
