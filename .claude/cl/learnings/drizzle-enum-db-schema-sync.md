---
scope: [backend, db]
files: [src/db/schema.ts, src/shared/schemas/event-history.ts]
issue: 112
date: 2026-03-26
---
When adding a new enum value to a Zod schema (e.g., `eventTypeSchema`), the Drizzle DB column enum in `schema.ts` must also be updated. They are separate definitions that must stay in sync — TypeScript/Drizzle will fail to compile if the Zod type includes a value the DB column doesn't accept. `pnpm db:generate` will say "No schema changes" (SQLite doesn't enforce check constraints from Drizzle's enum option), but the TS type mismatch is still a compile error.
