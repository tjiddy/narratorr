---
scope: [frontend]
files: [src/client/pages/activity/useActivity.test.ts]
issue: 301
source: review
date: 2026-04-02
---
When a mutation signature changes (e.g., from `(id)` to `({ id, retry })`), updating the test to compile is not the same as testing the contract. The hook test must assert the exact arguments forwarded to the API method (`.toHaveBeenCalledWith(id, { retry: value })`), not just that the call happened. Also test the invalidation behavior on both success and failure paths — success should invalidate, failure should not.
