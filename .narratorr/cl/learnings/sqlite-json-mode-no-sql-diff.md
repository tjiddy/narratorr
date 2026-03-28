---
scope: [db]
files: [src/db/schema.ts, drizzle/0000_tearful_nightcrawler.sql]
issue: 85
date: 2026-03-25
---
Drizzle's `text('col', { mode: 'json' }).$type<string[]>()` is an ORM-level serialization hint only — SQLite has no native JSON column type. The generated SQL still emits plain `text`. Running `pnpm db:generate` after adding `mode: 'json'` to a column produces "No schema changes, nothing to migrate" — no diff in `drizzle/`. Specs that treat this as a "migration needed" are wrong; the correct AC is "run db:generate and confirm no diff."
