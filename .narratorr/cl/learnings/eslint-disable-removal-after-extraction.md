---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx]
issue: 548
date: 2026-04-14
---
Extracting logic from a component (like tab state+keyboard nav from BookDetails) can reduce cyclomatic complexity below the eslint-disable threshold, causing a lint failure for "unused eslint-disable directive." Always check eslint-disable comments in files you extract from — they may need updating or removal.
