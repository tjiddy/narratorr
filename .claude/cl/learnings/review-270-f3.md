---
scope: [scope/backend]
files: [src/server/jobs/search.ts, src/server/jobs/search.test.ts]
issue: 270
source: review
date: 2026-03-08
---
A new behavioral contract (retryBudget.resetAll() at search cycle start) was added to runSearchJob but the test file wasn't updated. When adding a new side effect that constitutes an AC-level contract, always add a test that spies on the method and asserts it was called. Missing this creates silent regression risk if the call is refactored away.
