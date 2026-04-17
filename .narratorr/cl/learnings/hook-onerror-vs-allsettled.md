---
scope: [frontend]
files: [src/client/pages/library/useLibraryBulkActions.ts]
issue: 626
date: 2026-04-17
---
When testing mutation `onError` branches in hooks that use `Promise.allSettled`, the `onError` handler only fires when the `mutationFn` itself throws (before or during `allSettled`), not when individual promises reject — those are captured by `allSettled` and routed through `onSuccess` with partial failure counts. To trigger `onError` in tests, make the mocked API method throw synchronously (not `.mockRejectedValue`), since a sync throw inside the `.map()` callback propagates before `allSettled` can catch it.
