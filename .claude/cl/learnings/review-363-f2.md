---
scope: [frontend]
files: [src/client/pages/book/BookDetails.test.tsx]
issue: 363
source: review
date: 2026-03-15
---
When adding id-based ARIA linkage (e.g., `aria-labelledby` pointing to button ids), tests must assert that ids are non-empty and that the linkage updates when state changes. A test that only checks the initial panel linkage misses regressions where tab switching doesn't update the panel's `aria-labelledby`.
