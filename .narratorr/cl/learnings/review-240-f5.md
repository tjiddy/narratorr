---
scope: [backend]
files: [src/server/services/indexer.service.test.ts]
issue: 240
source: review
date: 2026-03-31
---
A concurrency test that only asserts "both were called and results collected" would also pass against the old sequential implementation. Use a deferred promise for one adapter and assert the other is called before the first resolves — this is the only way to prove `Promise.allSettled` fan-out vs sequential `for-of await`.
