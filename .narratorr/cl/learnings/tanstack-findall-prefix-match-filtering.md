---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 312
date: 2026-04-03
---
TanStack Query's `getQueryCache().findAll({ queryKey })` uses prefix matching, so `['activity']` returns both page queries (`['activity', params]`) and non-page queries (`['activity', 'counts']`). When iterating results to patch cached data, filter by data shape (`Array.isArray(query.state.data?.data)`) to skip queries with incompatible structures. Also track whether any matching queries existed (`hasPageQueries`) to distinguish "no pages loaded" from "pages loaded but target missing" — these require different invalidation strategies.
