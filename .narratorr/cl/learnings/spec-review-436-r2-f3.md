---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Round 1 fix stated the orchestrator would compose existing helpers without refactoring `import-steps.ts`, while simultaneously requiring SSE dedup behavior that the current `emitImportingStatus()` helper can't support (it emits both download and book status changes as a unit). Scope boundary claims ("no refactoring X") must be validated against every behavioral requirement in the spec — if a requirement needs a helper change, either adjust the scope boundary or adjust the requirement.
