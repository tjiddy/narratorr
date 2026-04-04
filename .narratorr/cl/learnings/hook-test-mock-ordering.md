---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 342
date: 2026-04-04
---
When testing `useLibraryImport`, the hook auto-scans on mount via a `useEffect` that fires once settings resolve. If a test overrides `mockScanDirectory` after `beforeEach` but before `renderHook`, the auto-scan may still use the `beforeEach` mock if it was already resolved. Use `mockReset()` (not just `mockResolvedValue`) to clear prior return values, and also `mockClear()` on downstream mocks like `mockStartMatchJob` to avoid stale call records from prior tests.
