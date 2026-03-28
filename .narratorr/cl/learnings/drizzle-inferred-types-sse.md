---
scope: [backend]
files: [src/shared/schemas/sse-events.ts, src/server/services/download.service.ts]
issue: 283
date: 2026-03-10
---
Drizzle's `$inferSelect` type for enum columns produces a string union that is technically compatible with Zod enum schemas but TypeScript can't prove assignability. When SSE payload schemas used `z.enum(downloadStatusValues)`, passing `DownloadRow['status']` caused TS2322. Fix: use `z.string()` for informational status fields in SSE payloads — the schemas are for consumer-side validation, not emission-side type enforcement.
