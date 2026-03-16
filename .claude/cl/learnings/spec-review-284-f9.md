---
scope: [scope/frontend, scope/backend]
files: [src/server/services/enrichment-utils.ts, src/core/metadata/schemas.ts]
issue: 284
source: spec-review
date: 2026-03-09
---
Spec said "frontend prepends URL_BASE to coverUrl" without acknowledging that the same `coverUrl` field carries both external absolute URLs (`https://media-amazon.com/...`) and app-relative paths (`/api/books/{id}/cover`). Blindly prefixing all coverUrl values would break external covers. When speccing URL rewriting, always check whether the target field has mixed value formats and define the conditional rule explicitly.
