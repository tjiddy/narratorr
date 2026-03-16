---
scope: [backend]
files: [src/shared/schemas/sse-events.ts, src/server/services/quality-gate.service.ts, src/server/services/download.service.ts, src/server/jobs/monitor.ts, src/server/services/import.service.ts]
issue: 283
source: review
date: 2026-03-10
---
When Drizzle ORM infers column types via `$inferSelect`, enum-like text columns become `string` rather than the narrower Zod enum union. SSE payload schemas must use the actual Zod enum schemas (e.g., `downloadStatusSchema`, `bookStatusSchema`) for type safety, and emission sites need explicit `as DownloadStatus` / `as BookStatus` casts where Drizzle row types are wider than the Zod enum. The initial implementation used `z.string()` as a shortcut to avoid the cast dance — reviewer correctly flagged this as losing the schema-as-source-of-truth guarantee.
