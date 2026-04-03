---
scope: [backend]
files: [src/server/routes/indexers.test.ts, src/server/routes/crud-routes.ts]
issue: 317
source: review
date: 2026-04-03
---
Widening a shared API contract (adding `metadata` to the test result) needs route-level assertions, not just service-level ones. The route handler in `crud-routes.ts` is the actual HTTP boundary — if it transforms or drops fields, service tests still pass while the client gets wrong data. When extending any shared route response shape, always add route-level tests asserting the new fields pass through unchanged.
