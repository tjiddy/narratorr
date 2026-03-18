---
scope: [frontend]
files: [src/client/pages/library/useLibraryFilters.ts, src/client/pages/library/LibraryPage.test.tsx]
issue: 372
date: 2026-03-15
---
When adding search debouncing to hooks that drive API params, integration tests need either fake timers or increased `waitFor` timeouts (2000ms+). The default 1000ms `waitFor` timeout plus 300ms debounce plus TanStack Query async resolution is too tight. Hook unit tests should use `vi.useFakeTimers({ shouldAdvanceTime: true })` with `vi.advanceTimersByTime(350)` to deterministically advance past the debounce. For page integration tests, `{ timeout: 2000 }` on `waitFor` is the pragmatic fix.
