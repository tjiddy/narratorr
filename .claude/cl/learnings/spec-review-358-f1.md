---
scope: [scope/api, scope/frontend]
files: []
issue: 358
source: spec-review
date: 2026-03-13
---
Reviewer caught that replacing `['eventHistory']` invalidation with `queryKeys.eventHistory.all()` would narrow TanStack Query's prefix-matching behavior — `all()` returns `['eventHistory', undefined]` which only matches that exact key, not filtered variants like `['eventHistory', { search: 'x' }]`. The spec missed this because `/elaborate` proposed a replacement without checking the runtime semantics of TanStack Query's `invalidateQueries` prefix matching. Fix: when centralizing query keys used for invalidation, verify that the replacement key preserves the same invalidation scope — prefix keys (shorter arrays) are broader than exact keys (longer arrays with parameters).
