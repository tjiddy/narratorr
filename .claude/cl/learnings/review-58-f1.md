---
scope: [scope/frontend]
files: [src/client/pages/activity/useActivity.ts]
issue: 58
source: review
date: 2026-03-22
---
The standard TanStack Query optimistic update pattern requires calling `queryClient.cancelQueries({ queryKey: [...] })` **before** patching cache state in `onMutate`. Without the cancel, any in-flight query for the same key (triggered by SSE-based invalidation or concurrent mutations) can resolve after the optimistic patch and overwrite it with stale data, recreating the flicker the optimistic update was meant to fix.

The issue was missed during implementation because it's easy to focus on the snapshot/restore logic and omit the cancel step. The spec also described the problem in terms of `setQueryData` and `onError` rollback without explicitly calling out the race condition with concurrent refetches.

What would have caught it: checking the "optimistic delete x existing activity invalidation/refetch paths" interaction — the SSE source (`useEventSource.ts:60-63`) that continuously invalidates activity queries was noted in exploration but not translated into a test requirement for in-flight cancellation.
