# pi-recall agent conventions

- Read README.md for scope and known limitations. FINDINGS.md records historical prototype results, not a fresh benchmark run.
- Keep this package independent: runtime imports must stay inside the repository except for host-provided Pi SDK and typebox.
- index.ts is the public entry; recall-extension.ts remains an alternate compatibility entry. Do not register both at once.
- history.ts contains pure current-branch history helpers. This package has no compaction hooks, storage, background tasks or model calls.
- Run `npm ci --ignore-scripts` to install locked development dependencies and `npm run check` for type checking, offline behavior tests and isolated SDK loading.
- Do not run benchmarks, live model calls, install into a user's Pi profile, publish, or change remote repositories without authorization.
- Do not select a project license on the maintainer's behalf. Preserve THIRD_PARTY_NOTICES.md.
