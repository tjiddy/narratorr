---
scope: [frontend]
files: [src/client/pages/library/LibraryTableView.tsx, src/client/pages/library/LibraryPage.test.tsx]
issue: 110
date: 2026-03-25
---
Clicking an inactive table column header in LibraryTableView calls only `onSortFieldChange(col.field)` — it does NOT reset the sort direction. The direction stays at its current value (default: 'desc'). So clicking "Sort by Title" from default state gives title + desc = "Title (Z→A)", not "Title (A→Z)". Tests that click column headers to set a field must account for the existing direction, not assume ascending.
