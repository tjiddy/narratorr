---
scope: [backend]
files: [src/server/services/merge.service.ts, src/server/services/merge.service.test.ts]
issue: 556
date: 2026-04-15
---
When migrating tests from `mergeBook()` to `enqueueMerge()`, `readdir` is called twice on `book.path` — once in `validateBookForMerge()` and once in `executeMerge()`. Tests using `mockResolvedValueOnce` for readdir will silently return `undefined` on the second call, causing test failures. Use `mockImplementation` with path-based routing instead.
