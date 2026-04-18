---
scope: [frontend]
files: [src/client/hooks/useEventSource.test.ts]
issue: 637
source: review
date: 2026-04-18
---
When testing TanStack Query cache patching via setQueryData, asserting that setQueryData was called is insufficient — it doesn't prove the updater function produced the right output. Always read the cache after the event with `queryClient.getQueryData()` and assert the actual patched values, including that non-matching rows stayed unchanged.
