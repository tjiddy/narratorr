---
scope: [backend, services]
files: [src/server/services/library-scan.service.test.ts]
issue: 356
date: 2026-03-15
---
When refactoring from per-item DB queries to full-table pre-fetch, the test mock pattern changes fundamentally: instead of `limit.mockResolvedValueOnce()` per loop iteration, you need `select.mockReturnValueOnce(mockDbChain(...))` for each pre-fetch query. If the test file uses a hand-rolled chain mock (`select → from → where → limit` as mockReturnThis), switching to `createMockDb()` + `mockDbChain()` is cleaner but requires a hybrid approach when other tests in the same file still need the old chain pattern.
