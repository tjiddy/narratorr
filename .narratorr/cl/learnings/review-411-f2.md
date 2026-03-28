---
scope: [scope/backend, scope/services]
files: [src/server/services/settings.service.test.ts]
issue: 411
source: review
date: 2026-03-16
---
Reviewer caught that the empty-partial test only asserted the return value, not the side-effect contract (no DB write). A test that only checks return values can't detect unnecessary persistence calls. Root cause: test was written to confirm "returns correct data" but missed the "doesn't write" half of a no-op contract. Would have been caught by applying the "assert consequences, not just return values" testing standard — for no-op behaviors, assert the absence of side effects.
