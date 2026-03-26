---
scope: [backend, services]
files: [src/server/services/merge.service.ts]
issue: 112
date: 2026-03-26
---
ESLint's `complexity` rule (limit 15) fires on `async mergeBook()` when guard checks + try/catch + multiple await steps push it past threshold (~22). The fix is to extract two private helper methods (`runStaging` and `commitMerge`) that each handle a coherent chunk — this also improves readability. Budget for this refactor upfront when designing long orchestrator methods; the complexity is mechanically predictable from the number of sequential steps.
