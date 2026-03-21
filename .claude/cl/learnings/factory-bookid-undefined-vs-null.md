---
scope: [frontend]
files: [src/client/__tests__/factories.ts, src/client/pages/activity/DownloadActions.test.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 48
date: 2026-03-21
---
`createMockDownload()` omits `bookId` by default, so all factory-produced mocks have `bookId: undefined`. When a guard uses `!= null` (which covers both null and undefined via loose equality), existing tests that expect a Retry button silently break because their factory-produced downloads lack `bookId`. Always explicitly set `bookId: 1` in tests that expect Retry to be visible — and use `bookId: null` for orphaned-download tests (the real runtime case from `SET NULL` FK), not just `undefined`.
