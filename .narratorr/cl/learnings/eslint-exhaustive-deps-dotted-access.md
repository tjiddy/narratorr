---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.tsx]
issue: 414
date: 2026-04-08
---
`react-hooks/exhaustive-deps` does not accept dotted property access (e.g., `obj.callback`) in dependency arrays — it demands the full object. To use a stable `useCallback` from a hook return object as an effect dependency, destructure it into a local variable first (e.g., `const { clampToTotal } = usePagination(...)`) and reference the variable in the deps array.
