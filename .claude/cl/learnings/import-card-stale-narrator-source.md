---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.tsx, src/client/pages/manual-import/useManualImport.ts]
issue: 80
date: 2026-03-24
---
In the manual import flow, `row.edited` is the single source of truth for user-selected state — `handleEdit()` updates it, and `handleImport()` reads from it. Display components should always read from `row.edited` (not `row.matchResult.bestMatch`) so they stay fresh after edits. Reading from `matchResult.bestMatch` is a stale-data bug: that field is never updated by edit operations.
