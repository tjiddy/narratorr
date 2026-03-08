---
scope: [scope/backend]
files: [src/server/services/event-history.service.ts, src/server/services/event-history.service.test.ts]
issue: 270
source: review
date: 2026-03-08
---
markFailed's fire-and-forget retrySearch trigger test only asserted `{ success: true }` without verifying the search was actually invoked. For fire-and-forget patterns, use `vi.waitFor()` to assert the async side effect was triggered (e.g., check that `searchAll` was called). Simply asserting the return value doesn't prove the side effect executed.
