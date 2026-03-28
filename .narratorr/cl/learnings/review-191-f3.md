---
scope: [frontend]
files: [apps/narratorr/src/client/hooks/useAuth.test.ts]
issue: 191
source: review
date: 2026-02-24
---
When testing TanStack Query cache invalidation in logout flows, `setQueryData(undefined)` clears the cache but `invalidateQueries` immediately refetches. If the mock always returns the same value, the cache gets repopulated before assertions run. Fix: use `mockResolvedValueOnce` for the initial load and `mockResolvedValue` for post-invalidation state, then assert both the refetch count and the updated cache value.
