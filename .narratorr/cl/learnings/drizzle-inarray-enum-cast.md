---
scope: [backend, db]
files: [src/server/routes/import-jobs.ts]
issue: 637
date: 2026-04-18
---
Drizzle's `inArray(column, values)` requires the values array to match the column's enum type. When splitting a query param string (`status.split(',')`) for a typed enum column, cast the result: `status.split(',') as ImportJobStatus[]`. Without the cast, TypeScript errors because `string[]` doesn't satisfy the narrow enum union.
