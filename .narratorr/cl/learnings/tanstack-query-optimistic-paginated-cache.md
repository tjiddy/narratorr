---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts]
issue: 58
date: 2026-03-22
---
When doing optimistic deletes with paginated TanStack Query caches, use `queryClient.getQueriesData({ queryKey: ['activity'] })` to enumerate ALL matching cache entries, then filter by `params.section` — not just `getQueryData` on a single key. Activity data is stored as `['activity', { section, limit, offset }]` entries, so there can be multiple history pages each with their own `{ data, total }` shape. Both `data` (remove item) and `total` (decrement) must be patched in `onMutate` and fully restored from snapshot in `onError`. Patching only `data` leaves `total` stale, which breaks the history count badge and `usePagination.clampToTotal()`.
