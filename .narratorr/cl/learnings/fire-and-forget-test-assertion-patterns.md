---
scope: [backend]
files: [src/server/services/merge.service.test.ts]
issue: 556
date: 2026-04-15
---
When migrating from synchronous to fire-and-forget async patterns, `rejects.toThrow()` assertions become impossible for execution-phase errors (they're caught by the internal `.catch()`). Replace with: (1) `log.error` mock assertions for error detection, (2) event broadcaster mock assertions for `merge_failed` events, (3) `settle()` helper (`setTimeout(50)`) after `enqueueMerge()` to let microtasks drain before checking side effects.
