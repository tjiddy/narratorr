---
scope: [scope/backend]
files: [src/server/routes/books.ts, src/server/services/book.service.ts]
issue: 331
source: spec-review
date: 2026-03-10
---
Spec used "soft-delete" terminology for the missing-files delete path even though the entire feature design is hard-delete + recycling bin record creation + restore by re-creation. The term "soft-delete" implies keeping the original row with a deleted flag, which is a materially different design. Prevention: avoid using established database terminology (soft-delete, hard-delete) loosely — verify the term matches the actual data flow. The current codebase uses hard deletes everywhere; using "soft-delete" in a spec invites confusion.
