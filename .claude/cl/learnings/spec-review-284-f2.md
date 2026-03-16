---
scope: [scope/backend, scope/frontend]
files: [src/server/services/enrichment-utils.ts]
issue: 284
source: spec-review
date: 2026-03-09
---
Missed server-generated cover URLs stored as root-relative paths (`/api/books/${id}/cover` in enrichment-utils.ts:63). These persist in the DB and would break under subpath deployment. When speccing URL rewriting features, always search for server-generated URLs that get stored or sent to the client — not just route definitions and API client paths.
