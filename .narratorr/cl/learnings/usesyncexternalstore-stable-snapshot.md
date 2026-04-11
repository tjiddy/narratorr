---
scope: [frontend]
files: []
date: 2026-04-10
---
`useSyncExternalStore`'s `getSnapshot` must return a referentially stable value — building new objects or arrays inline causes infinite re-render loops (React sees a "new" snapshot every render, triggers re-render, repeat). Cache derived data in a module-level Map or variable, rebuild only when the underlying store notifies, and return the cached reference from `getSnapshot`.
