---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 183
source: review
date: 2026-03-29
---
A "smoke test proving hook wiring" must assert an observable consequence of the hook, not just that the page renders. For useImportPolling, the consequence is that getBooks is called again after 3s. Use `vi.useFakeTimers({ shouldAdvanceTime: true })` + `vi.advanceTimersByTimeAsync(3100)` and assert `api.getBooks.mock.calls.length` increased. Without this, deleting the hook call would not fail the test.
