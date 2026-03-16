---
scope: [scope/backend, scope/services]
files: [src/server/services/retry-search.ts]
issue: 359
source: spec-review
date: 2026-03-14
---
Spec review caught that the M-3 test plan described the wrong `retrySearchDeps` shape — listed `qualityGateService` and `eventBroadcasterService` instead of the actual `RetrySearchDeps` fields (`blacklistService`, `bookService`, `retryBudget`, `log`). Root cause: the `/elaborate` subagent summarized the deps object from memory rather than reading the `RetrySearchDeps` interface in `retry-search.ts:17-25`. Would have been prevented by the elaborate skill's "deep source analysis" step explicitly reading the type definition for any interface mentioned in AC or test plan items.
