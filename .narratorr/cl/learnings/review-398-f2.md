---
scope: [scope/backend, scope/services]
files: [src/server/jobs/enrichment.test.ts]
issue: 398
source: review
date: 2026-04-07
---
Reviewer caught that `mockDbChain()` returns pre-shaped rows regardless of the projection argument passed to `db.select()`, so tests would pass even if the query regressed back to selecting only `duration` and `genres`. Root cause: mock infidelity — mocks that return data independent of their input can't catch missing-column regressions. Fix: assert the projection argument passed to the third `db.select()` call contains all required fields. Preventable by adding a "projection assertion" test whenever expanding a select query — the mock pattern in this codebase doesn't enforce projection correctness by default.
