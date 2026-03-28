---
scope: [frontend]
files: [src/client/pages/manual-import/useManualImport.ts]
issue: 114
source: review
date: 2026-03-25
---
`readyCount` was computed from match confidence without filtering by `r.selected`, so deselecting a high-confidence row didn't decrement the ready pill. The test plan explicitly required "Ready count reflects only selected non-duplicate rows" but no test exercised the deselect→decrement path. Would have been caught by a test that exercises toggle-off after a match result arrives.
