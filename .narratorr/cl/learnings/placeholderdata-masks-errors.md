---
scope: [frontend]
files: [src/client/hooks/useLibrary.ts, src/client/pages/library/useLibraryPageState.ts]
issue: 480
date: 2026-04-11
---
TanStack Query's `placeholderData: (prev) => prev` keeps stale data on refetch failure but still sets `isError: true`. Pages using this pattern MUST explicitly check `isError` — without it, the page silently shows stale or zero-default data with no error indication. The `isError` check should take precedence over any data-derived conditions (empty state, filter state) to prevent masking failures.
