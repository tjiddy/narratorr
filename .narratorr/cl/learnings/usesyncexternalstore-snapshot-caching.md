---
scope: [frontend]
files: [src/client/hooks/useSearchProgress.ts]
issue: 392
date: 2026-04-07
---
`useSyncExternalStore` requires the `getSnapshot` function to return referentially stable values. Returning `[...map.values()]` creates a new array on every call, causing infinite re-render loops. Cache the snapshot in a module-level variable and update it only in `notify()`.
