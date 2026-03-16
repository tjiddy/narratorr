---
scope: [scope/frontend]
files: [src/client/hooks/useEventSource.ts, src/client/lib/queryKeys.ts]
issue: 372
source: spec-review
date: 2026-03-15
---
When changing TanStack Query cache keys (e.g., adding pagination params), any code that patches or invalidates cached data by key must be updated too. SSE/WebSocket handlers that use `setQueryData` with the old key shape will silently stop working. Always check the SSE/real-time cache invalidation matrix when modifying query key structures.
