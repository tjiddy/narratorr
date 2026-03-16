---
scope: [scope/frontend, scope/api]
files: [src/server/jobs/search.ts, src/server/routes/search.ts]
issue: 282
source: spec-review
date: 2026-03-10
---
Bulk search spec defined client-side fan-out to a per-book endpoint but didn't specify the per-request response contract. The existing search infrastructure returns aggregate counts (searched/grabbed/skipped/errors) but no single-request result enum. When speccing fan-out to a new endpoint, must define the response shape including all possible result states so the client can compute aggregate counts deterministically.
