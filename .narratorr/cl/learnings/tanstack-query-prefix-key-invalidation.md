---
scope: [frontend]
files: [src/client/lib/queryKeys.ts, src/client/hooks/useEventSource.ts, src/client/hooks/useEventHistory.ts]
issue: 358
date: 2026-03-13
---
TanStack Query's `invalidateQueries` uses prefix matching: `['eventHistory']` invalidates ALL queries starting with that prefix (including `['eventHistory', { search: 'x' }]`), but `['eventHistory', undefined]` only matches that exact key. When centralizing inline query keys used for invalidation, always provide a separate `root()` factory returning the short prefix key, distinct from parameterized `all(params)` factories that include an extra element.
