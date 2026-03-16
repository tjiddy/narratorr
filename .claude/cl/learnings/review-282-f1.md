---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/LibraryTableView.tsx]
issue: 282
source: review
date: 2026-03-10
---
Table view shipped with static `<th>` elements and a Duration column instead of the required sortable headers and Date Added column. The issue spec explicitly called for sortable table columns and a Date Added column. During implementation, the table was treated as a display-only surface with sorting handled externally, but the spec expected inline sort controls on each column header. Lesson: when building a table view, cross-check every column and interaction against the spec — don't assume the toolbar sort controls are sufficient.
