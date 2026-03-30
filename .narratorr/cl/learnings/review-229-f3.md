---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 229
source: review
date: 2026-03-30
---
Torrent removal AC required `clientType` but the field was omitted because `getAdapter()` only returns the adapter, not the client row. The fix required an additional `getById()` call. When adding log fields that depend on data not directly available at the log site, check whether a lookup is needed rather than silently omitting the field.
