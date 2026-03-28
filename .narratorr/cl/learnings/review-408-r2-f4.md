---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.test.ts]
issue: 408
source: review
date: 2026-03-17
---
The expiry test only asserted db.delete was called, not the WHERE predicate arguments (status='pending', lt(createdAt, cutoff)). The AC8 race-safety contract depends on the predicate shape, so the test must assert the predicate to prevent regressions (e.g., dropping the status guard or changing lt to lte).
