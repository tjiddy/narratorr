---
scope: [backend]
files: [src/server/jobs/cover-backfill.test.ts]
issue: 369
source: review
date: 2026-04-06
---
Asserting `expect(where).toHaveBeenCalledTimes(1)` with `expect(arg).toBeDefined()` only proves *some* predicate was passed — it doesn't prove the predicate is correct. When testing Drizzle query filters, use the `containsSubstring` recursive inspector (pattern from book-list.service.test.ts) to assert specific column names and literal values in the predicate's `queryChunks`. Both halves of an `and()` predicate must be asserted independently — e.g., `containsSubstring(predicate, 'cover_url')` AND `containsSubstring(predicate, 'path')`. This ensures removing either condition breaks the test.
