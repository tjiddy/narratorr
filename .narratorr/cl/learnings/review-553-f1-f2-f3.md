---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/components/book/MetadataEditFields.tsx]
issue: 553
source: review
date: 2026-04-14
---
When extracting JSX into sub-components, test every interactive element and conditional render branch that moves — not just the parent's unchanged tests. The existing suite tested the parent modal end-to-end but didn't cover the refresh button callback chain (F1), moved header conditionals for narrator/quality display (F2), or the narrator field → save wiring through the extracted child (F3). A checklist during extraction: for each moved element, grep the test file for assertions on it — if absent, add coverage.
