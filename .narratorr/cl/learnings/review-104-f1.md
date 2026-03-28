---
scope: [backend, services]
files: [src/server/services/library-scan.service.ts, src/server/services/event-history.service.ts]
issue: 104
source: review
date: 2026-03-25
---
When an AC says "record a failure event on import failure", the scope must cover ALL failure points in the method — not just post-creation failures. importSingleBook() only wrapped enrichImportedBook() in try/catch, missing the case where bookService.create() itself throws. Fix required making bookId optional in CreateEventInput (the DB already allowed NULL via onDelete: set null) and adding a second try/catch around the create call. Check whether the DB schema supports null for the FK before assuming a missing-bookId event is impossible.
