---
scope: [scope/frontend]
files: [src/client/pages/activity/useActivity.test.ts]
issue: 268
source: review
date: 2026-03-09
---
New TanStack Query mutations (approve/reject) were added to the useActivity hook but the existing test file only covered cancel/retry mutations. When adding new mutations to a hook, the test file must be updated in the same PR with matching mutation tests following the existing pattern (mock API, trigger mutate, assert API called with correct args). Also, new download statuses added to queue/history classification need explicit test coverage.
