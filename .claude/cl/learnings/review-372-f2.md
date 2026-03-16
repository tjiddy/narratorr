---
scope: [scope/backend, scope/services]
files: [src/server/services/book.service.ts]
issue: 372
source: review
date: 2026-03-16
---
SQL REPLACE() operates globally on the entire string — using it to strip leading articles from titles also removes interior words ("Name of the Wolf" → "Name of Wolf"). Use CASE WHEN...LIKE 'the %' THEN SUBSTR() for position-specific stripping. Check existing utility functions (toSortTitle in naming.ts) for reference semantics before writing SQL equivalents.
