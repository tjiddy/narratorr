---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/LibraryPage.tsx, src/client/pages/library/useLibraryBulkActions.ts]
issue: 282
source: review
date: 2026-03-10
---
Bulk selection survived filter/search changes, meaning users could delete/search/update books they could no longer see. Fixed by intersecting selection with visible book IDs via useMemo in the bulk actions hook. The pattern of derived state (intersection) is cleaner than useEffect-based clearing which triggers the react-hooks/set-state-in-effect lint rule. Lesson: when selection and visibility are independent states, always derive the effective selection as an intersection rather than trying to synchronize them with effects.
