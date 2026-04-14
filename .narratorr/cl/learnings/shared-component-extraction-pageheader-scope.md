---
scope: [frontend]
files: [src/client/components/PageHeader.tsx, src/client/pages/manual-import/ManualImportPage.tsx, src/client/pages/library-import/LibraryImportPage.tsx, src/client/pages/library/LibraryHeader.tsx]
issue: 548
date: 2026-04-14
---
When extracting a shared component from pages with varying surrounding structure (back buttons, action links, filter rows), keep the shared component minimal (title+subtitle only) and use it inside the page-owned layout rather than absorbing the layout variations into props. Pages with back buttons inline with h1 (ManualImportPage, LibraryImportPage) can use PageHeader for title-only and keep their custom subtitle with `ml-10` offset page-owned.
