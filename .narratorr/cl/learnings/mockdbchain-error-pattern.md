---
scope: [backend]
files: [src/server/__tests__/helpers.ts]
issue: 408
date: 2026-03-17
---
To simulate a DB operation failure in tests, use `mockDbChain([], { error: new Error('...') })` — not a thrown function. The mockDbChain helper uses Promise.reject internally. Passing a function that throws doesn't work because the proxy chain doesn't invoke it.
