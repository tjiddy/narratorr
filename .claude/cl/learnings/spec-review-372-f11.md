---
scope: [scope/frontend]
files: [src/client/pages/library/useLibraryBulkActions.ts]
issue: 372
source: spec-review
date: 2026-03-15
---
When paginating a list that supports bulk actions, the spec must explicitly define whether bulk selection is page-scoped or cross-page. The implicit behavior change (full filtered set → current page only) is a meaningful UX regression that needs to be called out as intentional or addressed with cross-page selection support.
