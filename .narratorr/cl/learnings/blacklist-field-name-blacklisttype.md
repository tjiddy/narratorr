---
scope: [backend, db]
files: [src/db/schema.ts, src/server/services/blacklist.service.ts]
issue: 315
date: 2026-04-03
---
The blacklist table uses `blacklistType` (not `type`) for the permanent/temporary distinction. This was caught in spec review round 2 — the spec used `type 'permanent'` but the real field is `blacklistType`. Always read the actual schema definition before writing spec payloads; casual field name assumptions survive review rounds and waste implementation time.
