---
scope: [scope/frontend]
files: [src/client/lib/api/api-contracts.test.ts, src/client/lib/api/books.ts, src/client/lib/api/activity.ts, src/client/lib/api/blacklist.ts, src/client/lib/api/event-history.ts]
issue: 372
source: review
date: 2026-03-16
---
When adding new query params or new endpoints to API client methods, the API contract test suite must be updated in the same commit. The contract tests (api-contracts.test.ts) assert exact fetch paths and catch URL typos — new/changed query builders without contract tests can silently ship broken URLs. This is a sibling enumeration gap: every changed API method should trigger a check of the contract suite.
