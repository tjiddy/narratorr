---
scope: [backend]
files: [src/server/jobs/monitor.ts, src/server/jobs/monitor.test.ts]
issue: 537
source: review
date: 2026-04-13
---
When adding side effects to existing job functions (like recordDownloadFailedEvent in monitor.ts), the existing tests pass because the new dependency is optional/undefined. This means the new behavior has zero test coverage despite all tests passing. Always add tests for new side-effect branches even when they're fire-and-forget — pass the dependency explicitly in tests and assert it was called with correct arguments.
