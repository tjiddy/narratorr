---
scope: [scope/backend, scope/services]
files: [src/server/services/quality-gate.service.ts, src/server/services/quality-gate.service.test.ts]
issue: 350
source: spec-review
date: 2026-03-14
---
Spec review caught that C-1's test plan proposed mocking returned rows and asserting count, but the repo's service tests don't execute real SQL filtering — they inject whatever rows the mock returns. The existing pattern (import.service.test.ts:1684-1702) captures the Drizzle `where(...)` argument and asserts the predicate expression directly. The spec missed this because /elaborate didn't check how the target service's existing tests verify query shape before writing the test plan.
