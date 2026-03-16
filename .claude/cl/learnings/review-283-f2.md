---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 283
source: review
date: 2026-03-10
---
For high-frequency SSE events like `download_progress` (every few seconds per download), `invalidateQueries` triggers a full refetch which creates unnecessary network traffic. Use `queryClient.setQueryData` to patch the specific row in-place instead. This is the whole point of the `patch` vs `invalidate` distinction in the cache invalidation matrix — the matrix defined the concept but the implementation treated both the same.
