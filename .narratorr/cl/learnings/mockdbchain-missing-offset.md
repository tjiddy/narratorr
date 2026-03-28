---
scope: [backend]
files: [src/server/__tests__/helpers.ts]
issue: 355
date: 2026-03-13
---
The `mockDbChain()` helper didn't include `offset` in its chainable methods list, only `limit`. Adding new Drizzle query builder methods (offset, having, etc.) requires updating this helper. When tests fail with "query.X is not a function", check `mockDbChain` first.
