---
scope: [scope/backend, scope/db]
files: [src/db/schema.ts, src/core/metadata/audible.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that the spec relied on a "dominant library language" signal from a `books.language` column that doesn't exist in the schema. The elaboration step added language filtering to the test plan and AC without verifying the data source existed in the DB. The `REGION_LANGUAGES` mapping in audible.ts already provides a cleaner alternative. Gap: `/elaborate` deep source analysis checked for null guards and edge cases but didn't verify that the data fields referenced in the algorithm actually exist in the schema. Should have cross-referenced every field name in the algorithm design against `src/db/schema.ts` columns.
