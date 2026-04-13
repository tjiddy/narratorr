---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts, src/client/pages/activity/useActivity.test.ts]
issue: 537
date: 2026-04-13
---
When removing a feature from a hook that returns grouped objects (state/mutations/status), the test blast radius is larger than expected — every test that calls the hook with the old arity or asserts on removed return fields breaks. The `useActivity` hook went from 2 queries + 6 mutations to 1 query + 4 mutations, requiring 20+ test rewrites. The refetchInterval tests were particularly affected because they checked `toHaveBeenCalledTimes(2)` (queue + history) which became `1` (queue only).
