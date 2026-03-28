---
scope: [db]
files: [src/db/schema.ts, drizzle/0005_missing_indexes.sql]
issue: 354
date: 2026-03-15
---
When writing Drizzle migrations manually (due to drizzle-kit CJS/ESM issue), CREATE INDEX statements must use the SQL column names (snake_case like `enrichment_status`) not the Drizzle field names (camelCase like `enrichmentStatus`). Cross-reference each column's `text('sql_name')` definition in schema.ts to get the correct name.
