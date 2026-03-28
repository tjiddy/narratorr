---
scope: [backend]
files: [src/server/jobs/version-check.ts]
issue: 333
date: 2026-03-10
---
Module-level `let` variables used as caches (like `cachedUpdate` in version-check.ts) persist across test cases in Vitest because the module is loaded once. Always export a `_reset*()` function for test cleanup and call it in `beforeEach`. Without this, tests pollute each other and pass/fail depending on execution order.
