---
scope: [backend]
files: [src/server/services/import-list.service.test.ts]
issue: 393
source: review
date: 2026-03-15
---
When the spec says "replace duplicate helper", replacing the internals (Proxy-ifying the method list) doesn't satisfy the AC if the local function still exists. The reviewer correctly flagged that keeping `createChainableMockDb()` — even with Proxy internals — still means the repo has a separate DB-chain implementation that can drift. The full migration to shared `createMockDb()` + `mockDbChain()` was actually cleaner than expected because mockDbChain's thenable pattern eliminates the need to mock individual chain methods.
