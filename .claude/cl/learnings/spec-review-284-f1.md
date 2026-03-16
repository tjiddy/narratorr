---
scope: [scope/backend, scope/infra]
files: [src/server/routes/index.ts, src/server/plugins/auth.ts, src/server/index.ts]
issue: 284
source: spec-review
date: 2026-03-09
---
Spec assumed Fastify's `register({ prefix })` would provide a simple URL_BASE seam, but routes are registered directly with literal `/api/...` strings — no plugin scoping exists. The spec should have verified the actual route registration pattern before prescribing a prefix strategy. Fix: read `routes/index.ts` and representative route files during elaboration to confirm architectural seams exist before speccing against them.
