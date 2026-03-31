---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts, src/client/hooks/useMergeProgress.ts]
issue: 257
source: review
date: 2026-03-31
---
When useEventSource writes to an external store (useMergeProgress), the hook-level tests must verify the store transitions, not just cache invalidation and toasts. The store wiring through `updateMergeProgressFromEvent()` is an integration seam — testing only the store in isolation and only the hook in isolation misses the wiring. Need a test that mounts both hooks and simulates the full SSE → store state transition chain.
