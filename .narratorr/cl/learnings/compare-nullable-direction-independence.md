---
scope: [frontend]
files: [src/client/pages/library/helpers.ts]
issue: 287
date: 2026-04-01
---
When a comparison function encodes null-last ordering (returning 1 for null), callers that negate the result for descending sort will flip nulls to first. Fix: return a discriminated union `{ nullResult }` | `{ valueResult }` so the caller can apply direction negation only to non-null comparisons. This pattern applies anywhere a "nulls always last" comparator is used with bidirectional sorting.
