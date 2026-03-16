---
scope: [scope/backend, scope/services]
files: [src/server/services/metadata.service.ts, src/core/metadata/types.ts, src/core/metadata/audible.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that the round 1 fix introduced contradictory metadata query paths — spec described `search()` for warnings, `searchBooks(query, options)` for max-results, and `getAuthorBooks()` for authors, but none of these provided both features in one call. The fix tried to address three findings independently without checking that the combined result was internally consistent. Gap: when fixing multiple related findings in a single round, must re-read the full spec after all edits and verify the combined design is coherent. Each fix was correct in isolation but contradicted each other when composed.
