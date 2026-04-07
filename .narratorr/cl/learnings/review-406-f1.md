---
scope: [backend, services]
files: [src/server/routes/books.ts, src/server/routes/books.test.ts]
issue: 406
source: review
date: 2026-04-07
---
When wiring a new service dependency through route handlers, service-level tests prove the logic works but route-level tests prove the wiring is connected. If all route test fixtures lack the field that triggers the new dependency (e.g., no `infoHash`/`guid` in search results), the helper short-circuits and the dependency is never exercised. Route-level tests must include at least one fixture with the triggering field to catch miswired or missing dependencies. The spec's test plan mentioned "caller wiring" tests but only at the job/service level, not the route level.
