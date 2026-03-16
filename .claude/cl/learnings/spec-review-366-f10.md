---
scope: [scope/backend, scope/db]
files: [src/server/services/book.service.ts, src/db/schema.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that when F9 was fixed (signal extraction limited to `status = 'imported'`), the "not in library" candidate exclusion filter was also narrowed to imported-only. This created a gap where books in `wanted`/`searching`/`failed` status would be recommended even though `BookService.findDuplicate()` (used at add-time) checks all statuses. The fix for one scope (signal extraction) was incorrectly applied to a different scope (candidate exclusion). Gap: when a spec has multiple queries against the same table with different semantic purposes, each query's status filter must be defined independently. The round 2 fix should have asked "does this imported-only filter apply to ALL uses of the books table, or just signal extraction?"
