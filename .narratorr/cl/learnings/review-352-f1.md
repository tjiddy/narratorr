---
scope: [frontend]
files: [src/client/hooks/usePagination.ts, src/client/pages/library/useLibraryFilters.ts]
issue: 352
source: review
date: 2026-04-04
---
Reviewer caught that page from URL was applied via post-mount useEffect, causing the first API fetch to use offset=0 instead of the URL page offset. Root cause: usePagination didn't support an initial page parameter, so we used a one-shot effect which fires too late. Fix: add optional `initialPage` param to usePagination for synchronous initialization. Prevention: when adding URL-driven state to hooks that wrap other hooks, verify the first render produces correct derived values (like apiParams), not just eventual correctness after effects run.
