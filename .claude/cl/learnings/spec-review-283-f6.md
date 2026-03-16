---
scope: [scope/backend, scope/frontend]
files: [src/shared/schemas/book.ts, src/db/schema.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Spec referenced `BookStatus` enum for `book_status_change` events with transitions to `importing` and `failed`, but the shared Zod schema (`bookStatusSchema`) only had 5 values while the DB schema had 7. The import service was writing `importing`/`failed` directly to the DB, bypassing validation. The spec response from round 1 added the event contracts but didn't check whether the shared type actually covered all the statuses it named. Prevention: when a spec references a shared type/enum, verify it against BOTH the DB schema AND the shared Zod schema -- they can diverge.
