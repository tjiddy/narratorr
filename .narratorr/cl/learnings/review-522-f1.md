---
scope: [backend]
files: [src/server/services/import-orchestrator.test.ts, src/server/utils/import-steps.test.ts]
issue: 522
source: review
date: 2026-04-13
---
When moving a function to a module that is fully mocked in the original test file, the existing tests silently become vacuous — they exercise the mock's inline implementation, not the real function. The fix is to co-locate the unit tests with the real function's home module. The gap was not checking whether the test import path points to a mocked or real module.
