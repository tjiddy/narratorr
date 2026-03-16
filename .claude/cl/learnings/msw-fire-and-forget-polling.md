---
scope: [backend]
files: [apps/narratorr/src/server/__tests__/msw-handlers.ts]
issue: 181
date: 2026-02-22
---
Fire-and-forget notifications (DownloadService.grab → notify via Promise.resolve().catch()) don't await completion. In E2E tests, asserting the webhook was called immediately after grab() returns races the async notification. The reliable pattern: MSW handler pushes captured requests to an array, then `waitForRequests(captured, count, timeoutMs, intervalMs)` polls with bounded timeout before asserting. This is now in the shared msw-handlers.ts for reuse.
