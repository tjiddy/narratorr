---
scope: [scope/frontend, scope/ui]
files: [src/client/components/AddBookPopover.tsx, src/client/pages/author/BookRow.tsx]
issue: 342
source: spec-review
date: 2026-03-11
---
Spec listed `AddBookPopover.tsx` as the only file to modify but scoped the fix to "search result cards" only. Didn't grep for all callers of the shared component — `BookRow.tsx` on the author page also uses it. When a bug fix targets a shared component, always search for all import sites and include regression coverage for each caller in the AC and test plan.
