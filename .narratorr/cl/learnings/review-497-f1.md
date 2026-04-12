---
scope: [backend, core]
files: [src/core/metadata/audible.ts]
issue: 497
source: review
date: 2026-04-12
---
The Audible mapper truncated `publishedDate` to year-only (`slice(0,4)`) at line 259 while the spec required newest-first sorting. The explore phase found the field existed but didn't read the mapper deeply enough to catch the truncation. When a sort relies on a field, verify the full precision chain from API response through mapper to consumer — truncation at any layer breaks the contract.
