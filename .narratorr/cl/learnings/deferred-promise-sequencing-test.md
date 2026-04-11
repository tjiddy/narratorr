---
scope: [backend]
files: [src/server/services/health-check.service.test.ts]
issue: 481
date: 2026-04-11
---
To deterministically test fire-and-forget (non-blocking) behavior without flaky wall-clock assertions, use a deferred promise: create a promise that stays pending, call the method under test, assert it resolves while the deferred promise is still unsettled, then clean up by resolving/rejecting the deferred. This avoids `setTimeout` race conditions and works reliably in CI.
