---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.tsx, src/client/components/icons.tsx]
issue: 141
date: 2026-03-26
---
`CheckCircleIcon` does not exist in `src/client/components/icons.tsx`. The correct icon for success/check states is `CheckIcon` styled with a colored wrapper (`bg-primary/10` circle + `text-primary`). Always grep `icons.tsx` before assuming an icon variant exists.
