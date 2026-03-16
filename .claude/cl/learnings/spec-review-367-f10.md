---
scope: [scope/frontend]
files: [src/client/hooks/useLibrary.ts]
issue: 367
source: spec-review
date: 2026-03-16
---
Round 1 fixed the missing `queryKeys.books()` invalidation on add-to-library, but missed that `LibraryPage` also reads `useBookStats()` via a separate `queryKeys.bookStats()` cache entry with a 30-second staleTime. Any mutation that changes book counts must invalidate bookStats too, not just books. When fixing cache invalidation gaps, check ALL query keys that derive from the affected entity, not just the primary list query.
