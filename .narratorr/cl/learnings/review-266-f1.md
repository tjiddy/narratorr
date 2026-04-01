---
scope: [backend]
files: [src/server/services/book-list.service.ts]
issue: 266
source: review
date: 2026-04-01
---
When adding ORDER BY clauses that should only apply within a group (e.g., seriesPosition within a named series), make the clauses return neutral values for rows outside the group. Without this, rows that have stray data (e.g., seriesName=null but seriesPosition retained from metadata edits) get reordered unexpectedly. Use CASE WHEN to make clauses conditional on the group predicate.
