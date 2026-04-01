---
scope: [backend]
files: [src/server/utils/rejection-helpers.ts, src/db/schema.ts]
issue: 274
date: 2026-04-01
---
Drizzle inline `text('reason', { enum: [...] })` columns produce a narrow string literal union in `$inferInsert`. When extracting shared helpers that accept a blacklist reason, derive the type from the schema (`NonNullable<typeof blacklist.$inferInsert['reason']>`) instead of using bare `string` — otherwise TS rejects valid reason values at the call site.
