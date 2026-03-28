---
scope: [scope/backend, scope/services]
files: [src/server/services/settings.service.ts]
issue: 411
source: review
date: 2026-03-16
---
Reviewer caught that `patch('category', {})` still called `set()`, performing an unnecessary DB upsert. The issue spec explicitly documented empty-partial as a no-op edge case, but implementation didn't add the guard. Root cause: focused on the merge logic without considering the "nothing to merge" case. Would have been caught if `/plan` included a step to enumerate edge cases from the spec's test plan and ensure each has a code path.
