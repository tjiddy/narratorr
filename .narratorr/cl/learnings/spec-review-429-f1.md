---
scope: [scope/backend, scope/db]
files: []
issue: 429
source: spec-review
date: 2026-03-17
---
AC1 promised "ONE file + ONE registry entry" for new adapter types, but core `ADAPTER_FACTORIES` in `src/core/*/registry.ts` still require a factory entry per adapter — that's a separate file edit not eliminated by this issue. The elaboration only verified the shared/db enum duplication pattern (which is real) but didn't trace the full "add a new adapter" workflow through core factory registries. Would have been caught by checking: "for each AC, trace the concrete file edits a developer would make end-to-end and verify every one is addressed by the scope."
