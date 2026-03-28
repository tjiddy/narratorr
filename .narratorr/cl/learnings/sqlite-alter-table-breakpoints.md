---
scope: [backend, db]
files: [drizzle/0001_blacklist_type_and_expiry.sql]
issue: 271
date: 2026-03-09
---
SQLite cannot execute multiple ALTER TABLE statements as a single statement. Drizzle migrations need `--> statement-breakpoint` markers between each ALTER TABLE. When `pnpm db:generate` is broken (CJS/ESM issue on Windows with drizzle-kit), write migration SQL manually with these markers.
