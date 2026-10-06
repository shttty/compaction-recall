# HARD8 frozen comparison — descriptive only

Both runs use the same eight source-projected questions and actual snapshot bytes. All 24 records per run have explicit verdicts; completed resume made zero additional model calls. Paging uses the existing expand-only candidate, not the new uncommitted grep-entry-page work.

| Arm | Baseline correct | Expand-paging correct | Base mean answer seconds | Paging mean answer seconds |
|---|---:|---:|---:|---:|
| native | 1/8 | 0/8 | 19.9 | 18.2 |
| grep | 1/8 | 1/8 | 33.1 | 47.6 |
| production | 3/8 | 2/8 | 88.0 | 103.1 |

Production answer token total including cache: 16,073,204 -> 16,959,766 (delta +886,562). Cache reads: 13,980,160 -> 14,867,456. These are SDK normalized usage, not a billing estimate; compression/judge usage excluded.

Production mean answer-time delta: +15.1s. Shared original compression took 824.2s in summed stages, not charged again to paging. Provider TTFT, compression usage and billing remain unknown.

Production changed verdicts: {"gpt4_a1b77f9c": ["yes", "no"]}.

DEV8 previously measured production baseline 7/8, expand-paging 8/8; HARD8 measures 3/8 and 2/8. This does not establish stable improvement or causal regression. Native controls also vary (1/8 -> 0/8), model stochasticity and cache warming remain confounders. Do not merge or promote paging on the DEV8 gain alone.

## Evidence
- Baseline f5715d1901b6bedf19811030f18f3733eefb7bc4, audit SHA256 5dcc648c647cb5559590b9ee0e8e684f77dd2d60da00fb956dadd3c6c4d48d3f
- Expand-paging 7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014, audit SHA256 7735bf5def53b7883ca9789dae028518282044ce4ff917f391ee92c662ab5f2e
- Base additional exact-prefix/session usage proof: parent-hard8-base-session-provenance.json
- Paging auditor verifies all appended sessions against actual seed bytes, generated model identities, answers, usage and tools.
- New grep-pages branch remains WIP under two independent reviews; no benchmark run or deployment of that new branch.
