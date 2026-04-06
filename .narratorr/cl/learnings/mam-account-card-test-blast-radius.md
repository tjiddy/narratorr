---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.test.tsx, src/client/components/settings/IndexerCard.test.tsx]
issue: 383
date: 2026-04-06
---
Renaming the MAM status component required updating the refresh button title string ("Refresh VIP status" → "Refresh MAM status") across 12 test references in 2 test files. When refactoring components that include interactive elements with title/aria attributes used in test selectors, use `replace_all` to catch all occurrences — manual search-and-replace is error-prone at this scale.
