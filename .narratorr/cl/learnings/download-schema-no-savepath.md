---
scope: [backend]
files: [src/server/services/import.service.ts, src/db/schema.ts]
issue: 229
date: 2026-03-30
---
The downloads table schema does not have a `savePath` column — `savePath` is a computed value resolved at runtime by `resolveSavePath()` using the download client adapter and remote path mappings. Referencing `download.savePath` in log fields causes a TypeScript error. Always verify schema fields exist before referencing them in log statements.
