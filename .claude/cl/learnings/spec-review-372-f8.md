---
scope: [scope/frontend, scope/backend]
files: [src/client/pages/library/LibraryPage.tsx, src/client/pages/library/LibraryActions.tsx]
issue: 372
source: spec-review
date: 2026-03-15
---
When moving data from client-side full-array to paginated server-side, trace ALL consumers of the full array — not just the primary list rendering. LibraryPage derived missingCount/wantedCount from the full books array for action button visibility and confirmation text. The stats endpoint needed to cover these global counts, not just the tab/filter counts that were the obvious use case.
