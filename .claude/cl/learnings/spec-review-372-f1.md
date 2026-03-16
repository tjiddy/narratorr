---
scope: [scope/backend, scope/frontend]
files: [src/shared/schemas/book.ts, src/client/pages/library/helpers.ts]
issue: 372
source: spec-review
date: 2026-03-15
---
Stats endpoint proposed status keys (`snatched`, `downloaded`) that don't exist in the book status schema. The library UI groups raw statuses into tab categories via `matchesStatusFilter()`. When proposing API contracts that return domain-specific aggregations, verify the actual enum values and any UI-level grouping logic before naming fields.
