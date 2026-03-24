---
scope: [backend, services]
files: [src/server/services/import-orchestrator.ts, src/server/services/import.service.ts]
issue: 436
date: 2026-03-17
---
When an orchestrator wraps a service method with pre/post side effects, it needs context data (download title, book status, author name) that the service also loads internally. Rather than duplicating the query or changing the service return type, expose a lightweight `getImportContext()` method on the service that returns just the context needed for side effects. The orchestrator calls it once before the import, then uses the context for both success and failure paths.
