---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/components/book/BookMetadataModal.tsx]
issue: 553
date: 2026-04-14
---
When planning component extractions to remove eslint suppressions, check the actual `max-lines-per-function` limit (150 in this project, with skipBlankLines/skipComments) early — not just file line count (350). A file can be under 350 lines while the exported function is still over 150 effective lines, requiring additional extraction layers (header, sub-phases) that weren't in the initial plan.
