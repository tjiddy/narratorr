---
scope: [backend]
files: [src/shared/schema-db-alignment.test.ts, src/shared/schemas/blacklist.ts]
issue: 321
source: review
date: 2026-04-05
---
Reviewer caught that parse-only tests (schema.safeParse) don't prove the schema is actually derived from the canonical tuple — if someone reverts to a hardcoded array with the same values, tests still pass. The fix is alignment tests that assert `schema.options === tuple` and `dbColumn.enumValues === tuple`. The existing `schema-db-alignment.test.ts` pattern should be extended whenever a new shared tuple is introduced. The plan should have flagged this since the alignment test file was already in the codebase.
