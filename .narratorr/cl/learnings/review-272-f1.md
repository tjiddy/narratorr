---
scope: [backend, core]
files: [src/shared/schemas/indexer.ts]
issue: 272
source: review
date: 2026-04-01
---
The form schema (`createIndexerFormSchema`) and server CRUD schemas (`createIndexerSchema`/`updateIndexerSchema`) are separate code paths. Adding `.trim()` to form schema fields doesn't affect the server schemas which use `z.record()` for settings. Server-side trim requires a `.transform()` on the record. Always verify both schema layers when adding validation.
