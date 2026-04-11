---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx, src/client/pages/library/useLibraryPageState.ts]
issue: 480
date: 2026-04-11
---
The LibraryPage empty-state gate relied solely on `totalAll` derived from `useBookStats()`, but `useLibrary()` (books query) is a separate query. When stats fail, `computeStatusCounts(undefined)` returns all zeros, triggering `EmptyLibraryState` even when books loaded successfully. Any page with multi-query state derivation should guard empty/zero gates against partial query failure — check the primary data source (`totalBooks` from the books query) alongside derived aggregates.
