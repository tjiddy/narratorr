---
scope: [backend]
files: [src/server/services/quality-gate.service.test.ts]
issue: 299
source: review
date: 2026-04-02
---
When testing a DB query method, asserting the return value from a mocked DB chain only proves the mock works — it doesn't verify the query selector. Always assert the `.where()` predicate using `chain.where.toHaveBeenCalledWith(expected)` to catch selector regressions. The existing `getCompletedDownloads` test already used this pattern (line 75), but it wasn't followed for the new method.
