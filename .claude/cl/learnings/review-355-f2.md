---
scope: [backend]
files: [src/server/routes/books.test.ts, src/server/routes/activity.test.ts, src/server/routes/event-history.test.ts, src/server/routes/blacklist.test.ts]
issue: 355
source: review
date: 2026-03-14
---
When adding new query params to routes, always add route-level integration tests that (1) inject the params and assert the service receives them, and (2) inject invalid values and assert 400 rejection. Updating existing tests for the new response shape is necessary but not sufficient — the new query surface itself needs direct coverage.
