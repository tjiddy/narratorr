---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.tsx, src/client/hooks/usePagination.ts]
issue: 93
date: 2026-03-25
---
Navigating to a new page in a TanStack Query-backed component briefly sets `data = undefined` for the new query key (no cached data). If a `useEffect` reads a derived total from that data (`queueTotal = queueQuery.data?.total ?? 0`), the total transiently becomes `0`, which can trigger a clamp effect that resets the page back to 1. This makes pagination navigation tests via button clicks unreliable. The fix is to test the `clampToTotal` hook behavior directly via `renderHook` instead of through the full component. Adding `placeholderData: keepPreviousData` to `useActivitySection` would fix the production race too.
