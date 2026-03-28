---
scope: [backend, services]
files: [src/server/services/bulk-operation.service.ts, src/server/services/bulk-operation.service.test.ts]
issue: 187
date: 2026-03-28
---
When testing TTL cleanup in `bulk-operation.service`, do NOT use `waitForJob()` with `vi.useFakeTimers()` — the helper uses `setTimeout(resolve, 10)` internally and will stall with fake timers. Instead, use `vi.advanceTimersByTimeAsync(1)` ×10 to flush microtasks (same pattern as `match-job.service.test.ts:172`). This is consistent across all job services with TTL.
