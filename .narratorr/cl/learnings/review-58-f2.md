---
scope: [scope/frontend]
files: [src/client/pages/activity/useActivity.test.ts]
issue: 58
source: review
date: 2026-03-22
---
Optimistic update tests must exercise the timing guarantee: the card is removed BEFORE the API resolves, and stale refetches do not repaint the removed card. The initial test suite covered snapshot/restore correctly but did not include a test starting with an already-running query that resolved after `onMutate`. This means the missing `cancelQueries` call would have passed the entire test suite.

The test gap: "assert the deleted item does not reappear when the stale query response settles" — specifically, mock the next history `getActivity` call to be deferred, trigger `invalidateQueries` to start a background refetch, delete while that refetch is in-flight, then resolve the stale refetch and verify the cancelled result is discarded.

Key implementation detail: when checking `queryClient.getQueryData` for the key the hook actually creates, the key must match the hook's own `queryKeys.activity(fullParams)` call — which uses the raw params object without limit/offset when called with defaults. Using `queryKeys.activity({ section: 'history', limit: 10, offset: 0 })` when the hook creates `queryKeys.activity({ section: 'history' })` produces key mismatch and undefined cache reads.
