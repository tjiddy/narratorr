---
scope: [scope/backend, scope/db]
files: [src/server/services/book-rejection.service.ts]
issue: 274
source: review
date: 2026-04-01
---
**What was caught:** DB-1 violation — `rejectAsWrongRelease()` deleted library files before persisting the book reset. If the process crashed after `deleteBookFiles()` but before the DB update, the database would still show the book as imported with a valid path even though files were already gone.

**Why we missed it:** The CLAUDE.md gotcha about DB-1 ("Update the database immediately after the first irreversible filesystem step") was known, but during implementation the file deletion was placed first because it logically belonged with the "cleanup" phase. The ordering wasn't validated against the DB-1 rule.

**What would have prevented it:** During `/implement` step 4b (green phase), when a service method performs both DB writes and filesystem operations, explicitly verify DB-1 ordering: "Does any irreversible FS operation happen before the DB write that records its consequence?"
