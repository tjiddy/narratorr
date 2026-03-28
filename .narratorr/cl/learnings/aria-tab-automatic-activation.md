---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/search/SearchResults.tsx]
issue: 363
date: 2026-03-15
---
ARIA tab activation model must be explicitly decided during spec: "automatic" (arrow keys immediately activate + swap panel) vs "manual" (arrows only move focus, Enter/Space activates). This was a blocking spec review finding. The `getArrowTabIndex` helper with modulo wrapping + `useRef<HTMLButtonElement[]>` for focus management is the established pattern now.
