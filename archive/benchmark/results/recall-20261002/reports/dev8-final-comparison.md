# DEV8: three frozen candidates

All three have24durable answered and explicitly graded records, all8same actual snapshot bytes per arm/candidate, completed-resume0new calls and unchanged tracked artifacts. Independent unit/spec checks do not substitute for these measurements.

| Candidate | Native | Grep-only | Production | Production mean answer s | Production answer tokens inclcache | Cache-read tokens |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 0/8 | 5/8 | 7/8 | 32.3 | 7,004,658 | 4,744,704 |
| Paging | 0/8 | 6/8 | 8/8 | 35.8 | 7,594,443 | 5,327,360 |
| Grep coverage | 0/8 | 4/8 | 7/8 | 37.0 | 7,601,487 | 5,605,376 |

Plugin commits: baseline f5715d1901b6bedf19811030f18f3733eefb7bc4; paging7d1980b8b7512ec8568c3ddaaecdccb8e0ad4014; coverage5acf40efa9cb33146d3e9526fc411a769511cee8. Capacity policy fixed372000/16384/5000; SDK1.0.0. Coverage runner is baseHEAD858ae2fe5729edf7067dc34d8f7bf902ab4423f4 plus hash-frozen WIP SHA96abdfebae58f8a612509f0ef6502e180c35b7b8712f9d06f179d9bc1a2f2777 (only allowlist change in runtime); baseline/paging use frozen858 runner. Protected compression fingerprints unchanged.

Coverage has no measured accuracy gain in this descriptive single eight-question run. Keep its generic correctness/output-budget repair experimental; do not merge based on scores alone. Its production982b5123 miss involved4history_recall+1history_expand andNOhistory_grep; it found the booking interval butnot the elapsed trip interval. Do not attribute that failure directly to grep display code or claim statistical causal harm. Paging is the promising current candidate for harder-set comparison; model randomness/cache/provider conditions remain uncontrolled. Usage covers only newly appended answer-assistant SDK responses includingcache, notjudge/compression; billing/providerTTFTunknown.

Parent audits: parent-dev8-capacity-base-audit.json SHA490adf20df104f27547d1c2e7d5cf25a513446e37cd38a4a9c54ab9989284234; parent-dev8-capacity-paging-audit.json SHA4ba85e055ef161ce70be4ac7a151b88cbfbd6a052c4ec5b9383494faf35b248a; parent-dev8-coverage-audit.json SHAcf0ef1d1e349d1b5e2d37cf037f701de6fa87deb3903629818dd1b76cda21645.

HARD8: frozen/disjoint,7multi-session+1temporal. Parent streamed all500original M records and bounded-file-hashed sourcefb5413e3b077c62927daab794836991a2fcfa61ceacab57dc679fb02daaff2d9; verified8selected question/gold projections, exact labeled evidence segments andscores, all8initial capacity preflights. Global ranking notrerun; later compaction preflights stillrequired. Sourceproofparent-hard8-source-audit.json SHA29c8be4775d97a0af70a5c890b6127f04c86b77afa9169969ed153d58def6953. HARD8paired singlepilot baseline/paging is running; no scored HARD8 results yet. No mainmerge/push/install/profilechange/publish/full48.
