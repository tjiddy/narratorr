---
scope: [backend, db]
files: [src/db/schema.ts, src/server/services/recycling-bin.service.ts]
issue: 79
date: 2026-03-24
---
Drizzle `text('col', { mode: 'json' }).$type<string[]>()` stores arrays as JSON text and auto-deserializes on read. No manual `JSON.parse` needed in service code. The client type must match (updated `RecyclingBinEntry.authorName` from `string | null` to `string[] | null`). The UI must join for display: `entry.authorName?.length ? entry.authorName.join(', ') : null`.
