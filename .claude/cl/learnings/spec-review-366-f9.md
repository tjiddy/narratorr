---
scope: [scope/backend, scope/db]
files: [src/db/schema.ts, src/shared/schemas/book.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that "the user's library" was ambiguous — the books table stores 7 different status values and the spec never defined which ones count for signal extraction. This is a recurring pattern: specs that reference "all books" or "the library" without acknowledging that the DB stores entities in multiple lifecycle states. Gap: `/elaborate` and `/respond-to-spec-review` should check whether the target table has a status/lifecycle column and, if so, require the spec to explicitly filter.
