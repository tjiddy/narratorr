---
scope: [db, backend]
files: [packages/db/src/schema.ts]
issue: 127
date: 2026-02-23
---
Adding a new value to a Drizzle `text` column enum in SQLite doesn't require a migration. The enum constraint is TypeScript-only — SQLite stores plain text. Running `pnpm db:generate` correctly produces no migration file. Don't waste time expecting one.
