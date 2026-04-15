---
scope: [backend]
files: [src/server/routes/indexers.test.ts, src/server/routes/download-clients.test.ts, src/server/routes/notifiers.test.ts, src/server/routes/import-lists.test.ts]
issue: 557
source: review
date: 2026-04-15
---
Schema-level tests alone don't prove the HTTP contract. When adding new validation branches to shared Zod schemas consumed by Fastify routes, also add `app.inject()` route-level integration tests that verify: (1) the HTTP status code, (2) the error message contains the failing field path, and (3) the downstream service method was not called. This is especially important for the typed-settings validation because Fastify's Zod type provider wiring could silently fail while schema unit tests remain green.
