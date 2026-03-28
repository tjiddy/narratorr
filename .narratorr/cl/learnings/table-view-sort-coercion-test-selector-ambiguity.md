---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx, src/client/pages/library/LibraryTableView.tsx]
issue: 110
date: 2026-03-25
---
In table view, the toolbar's SortDropdown trigger button and the table column header sort buttons both match `/date added/i` — so `getByRole('button', { name: /date added/i })` throws "multiple elements found" when both are rendered. Use an anchored regex like `/^Date Added \(Newest\)$/i` or the exact aria-label to target the toolbar trigger specifically. The column header uses "Sort by Date Added" while the toolbar trigger uses "Date Added (Newest)".
