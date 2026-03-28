---
scope: [backend, services]
files: [src/server/services/quality-gate.service.test.ts, src/server/services/tagging.service.test.ts, src/server/services/recycling-bin.service.test.ts]
issue: 71
date: 2026-03-24
---
When a service method gains an additional DB query (e.g., a narrator junction SELECT added alongside the existing book SELECT), every `mockReturnValueOnce` chain in every test for that service must shift by one. The first mock result now feeds the new query, not the test's expected main result. This is the #1 source of "wrong value" test failures when adding junction table lookups — always audit ALL tests in the file after adding a new query to a service method.
