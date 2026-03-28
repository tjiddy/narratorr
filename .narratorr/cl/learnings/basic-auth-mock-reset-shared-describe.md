---
scope: [backend]
files: [src/server/plugins/auth.plugin.test.ts]
issue: 382
date: 2026-03-15
---
The `mode: basic` describe block creates `authService` in `beforeAll` but had no `beforeEach` reset. When adding tests that assert `verifyCredentials` was NOT called, accumulated calls from earlier tests caused false failures. Adding `afterEach(() => mock.mockReset())` fixed it. Watch for this pattern in any shared-service test blocks that use `beforeAll` without per-test cleanup.
