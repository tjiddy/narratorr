---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts, src/client/pages/activity/useActivity.test.ts]
issue: 54
source: review
date: 2026-03-21
---
When adding cache invalidation tests for a mutation, asserting only the new keys (eventHistory) while omitting the existing ones (activity) leaves the core list-refresh behavior unproven. The ['activity'] invalidation is what actually removes the deleted card from the UI — without it, the history list stays stale. Pattern: when a mutation's onSuccess calls invalidateActivity() AND additional keys, the test must assert ALL keys, not just the newly-added ones.
