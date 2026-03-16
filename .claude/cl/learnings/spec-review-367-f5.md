---
scope: [scope/frontend]
files: [src/client/pages/search/SearchBookCard.tsx]
issue: 367
source: spec-review
date: 2026-03-16
---
Spec mentioned optimistic add/dismiss and invalidating discover queries, but missed that adding a suggestion to the library also affects `queryKeys.books()`. The existing pattern in `SearchBookCard.tsx:38,44` invalidates `queryKeys.books()` on both success and 409. Any mutation that creates a book must invalidate library-facing query keys — the spec should have checked existing add-to-library patterns for cache invalidation scope.
