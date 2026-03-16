---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 372
date: 2026-03-15
---
When migrating client-side filtering to server-side, test mocks must simulate server behavior. Using `mockResolvedValue` with static data won't work — use `mockImplementation` that inspects params and filters/sorts the mock data accordingly. This was the biggest source of test failures in #372. The `mockLibraryData` helper pattern (single function that sets up both data + stats mocks with param-aware filtering) saved massive repetition.
