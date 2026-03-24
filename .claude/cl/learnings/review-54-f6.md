---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts, src/client/pages/activity/useActivity.test.ts]
issue: 54
source: review
date: 2026-03-21
---
Same gap as F5 for the bulk-clear mutation: asserting only the event-history invalidation key misses the ['activity'] key that drives the history list to empty/refetch. When writing hook invalidation tests for new mutations, always assert every queryClient.invalidateQueries call in onSuccess — not just the ones unique to the new feature.
