---
scope: [backend]
files: [src/server/services/import-orchestrator.test.ts, src/server/utils/import-steps.ts]
issue: 522
date: 2026-04-13
---
When moving a function from module A to module B, and module B is mocked in A's tests, the mock must include the moved function. `importOriginal` can fail if the real module has heavy dependencies (fs, DB). Inlining a minimal copy of the function logic in the mock factory is more reliable than `importOriginal` for pure classifier functions. Alternatively, import the function from its new location separately (outside the mock) for direct unit tests.
