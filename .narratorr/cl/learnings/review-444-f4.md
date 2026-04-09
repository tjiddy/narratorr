---
scope: [frontend]
files: [src/client/pages/book/useBookActions.test.ts]
issue: 444
source: review
date: 2026-04-09
---
Query invalidation tests must assert the exact query keys invalidated, not just that `invalidateQueries` was called. `expect(spy).toHaveBeenCalled()` is vacuous — it passes even if only an unrelated key is invalidated. When the mutation contract says "invalidate book, bookFiles, and books", the test must assert all three exact key arrays.
