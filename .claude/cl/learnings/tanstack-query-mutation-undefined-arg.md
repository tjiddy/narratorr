---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts]
issue: 54
date: 2026-03-21
---
TanStack Query v5 `mutation.mutate(undefined)` calls `mutationFn(undefined, context)`. If the mutationFn signature is `(variables) => api.fn(variables)`, passing `undefined` will call `api.fn(undefined)`. To create a zero-argument mutation (e.g., bulk clear), define `mutationFn: () => api.fn()` (ignoring the variables argument entirely) and call `mutate()` with no argument or `mutate(undefined)`.
