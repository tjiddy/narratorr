---
scope: [backend]
files: [src/server/services/recycling-bin.service.test.ts]
issue: 331
date: 2026-03-10
---
Queue-based Drizzle ORM mocks (where chained builder calls consume queued return values) must have their queue populated per-test, not in beforeEach. When a multi-step flow (e.g., restore: getById → conflict check → insert → delete) needs different queue entries per test scenario, beforeEach-populated queues get consumed by earlier tests' setup calls, leaving later tests with wrong data. Extract a helper function (e.g., `queueHappyRestore()`) called at the start of each test instead.
