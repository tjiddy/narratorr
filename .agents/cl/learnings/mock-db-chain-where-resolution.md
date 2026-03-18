---
scope: [scope/backend]
files: [apps/narratorr/src/server/services/library-scan.service.test.ts]
issue: 202
date: 2026-02-24
---
The existing mock DB pattern (`select/from/where/limit` all returning `this` via `mockReturnThis()`) means the final method in the chain is the one that resolves the promise. For queries ending at `.where()` (like the rescan query without `.limit()`), mock `.where` to resolve directly with `mockResolvedValueOnce([...rows])`. For queries with `.limit()`, mock `.limit` instead. Know which method terminates your query chain before writing mock expectations.
