---
scope: [scope/backend, scope/db]
files: [src/shared/schemas/indexer.ts, src/shared/schemas/download-client.ts, src/shared/schemas/import-list.ts, src/shared/schemas/notifier.ts]
issue: 429
source: spec-review
date: 2026-03-17
---
The circular-dependency note stated "schemas do NOT import from registries at runtime for adapter types" — but all four adapter-type schemas already do exactly that (line 2 of each file imports its registry for `superRefine` validation). The note was written based on the `downloadStatusSchema` pattern where the schema is standalone, without checking whether other schema files follow the same pattern. Would have been caught by: "when writing architectural rules about import directions, grep the actual codebase to verify the rule matches reality before committing it to the spec."
