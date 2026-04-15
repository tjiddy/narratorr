---
scope: [frontend]
files: [src/client/components/PageLoading.tsx, src/client/pages/library/LibraryPage.tsx]
issue: 564
date: 2026-04-15
---
Full-page loading states often include specialized headers with actions (e.g., LibraryHeader's Import Files link). A generic PageLoading component needs a `header?: ReactNode` slot, not just a title/subtitle API, to preserve these action affordances during loading.
