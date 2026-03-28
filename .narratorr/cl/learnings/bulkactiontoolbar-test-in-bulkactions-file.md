---
scope: [frontend]
files: [src/client/pages/library/BulkActionToolbar.tsx, src/client/pages/library/BulkActions.test.tsx]
issue: 148
date: 2026-03-26
---
`BulkActionToolbar` has no co-located test file (`BulkActionToolbar.test.tsx` does not exist). Its test coverage lives in `BulkActions.test.tsx` alongside the hook `useLibraryBulkActions`. The spec wording "co-located test files" was inaccurate and caused a spec review blocking finding. Always verify test file locations exist before naming them in specs — don't assume co-location just because the component exists.
