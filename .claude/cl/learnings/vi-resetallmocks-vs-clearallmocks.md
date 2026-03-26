---
scope: [backend, services]
files: [src/server/services/merge.service.test.ts]
issue: 112
date: 2026-03-26
---
`vi.clearAllMocks()` in beforeEach only clears call counts/instances — it does NOT reset `mockResolvedValue`/`mockReturnValue` implementations set by previous tests. Use `vi.resetAllMocks()` when tests set different mock return values per test; otherwise stale implementations from an earlier test will make later tests pass vacuously (or fail on wrong-path logic). This caused the NO_TOP_LEVEL_FILES guard test to pass before implementation due to stale happy-path mock.
