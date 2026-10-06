# Historical implementations and method notes

- `js-runtime/`: pre-SQLite JS worker/index implementation retained for historical behavior checks and comparisons.
- `prototype/`: old SQLite strategy arms, MiniSearch, alternate index storage and structured/concept-query experiments. None replaces production `src/`.
- `benchmark/`: original experiment drivers/support, projected non-text metrics and reports. Original full result bytes remain external; published hashes identify their original source, not byte identity after projection.
- `doc/`: outdated designs, prompt variants, method notes and historical reports. Figures are not new measurements of the released runtime.

The maintained runner/support closure, current commands, public source metadata and 16 authorized frozen Chinese questions are documented in [the benchmark guide](../doc/benchmark.md). No English original questions, reference answers, model answers, retrieved excerpts or full histories are restored by this move.

MiniSearch's historical prototype has its own locked package manifest; its dependency is not part of production or the current root development install. No old model evaluation, performance matrix or MiniSearch demo was rerun during this reorganization. Exact replay of an earlier run requires its matching external inputs/candidate/source hashes, not a sibling worktree.
