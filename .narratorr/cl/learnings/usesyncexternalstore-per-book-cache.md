---
scope: [frontend]
files: [src/client/hooks/useMergeProgress.ts]
issue: 422
date: 2026-04-08
---
`useSyncExternalStore` requires stable (referentially equal) getSnapshot return values — creating new objects in the snapshot function causes infinite re-render loops ("The result of getSnapshot should be cached"). When deriving per-key views from a Map-based store, build a separate `perBookCache` Map in the `notify()` function and read from it in the snapshot, rather than constructing objects inline. This pattern is needed whenever a module-level external store serves both list and per-item accessors.
