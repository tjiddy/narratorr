---
scope: [backend, services]
files: [src/server/services/quality-gate.service.ts, src/server/services/quality-gate.service.test.ts]
issue: 356
source: review
date: 2026-03-15
---
When batch-fetching ordered results (ORDER BY id DESC), the dedup/selection logic must be tested with multiple rows per key. The "first write wins" pattern depends on ordering being correct — if a future change drops the ORDER BY, all tests would still pass unless at least one test provides multiple rows per key and asserts the correct one is selected.
