---
scope: [backend, services]
files: [src/server/services/rename.service.ts, src/server/routes/index.ts]
issue: 356
date: 2026-03-15
---
Adding `db` as a constructor parameter to an existing service requires updating: (1) the service class, (2) routes/index.ts wiring, (3) ALL test helpers that create the service — including one-off inline constructions in test blocks (not just the `createService()` helper). Grep for `new ServiceName(` to catch them all.
