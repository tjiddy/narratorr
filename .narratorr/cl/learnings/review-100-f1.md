---
scope: [frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 100
source: review
date: 2026-03-25
---
When asserting DOM order for a moved JSX section, assert ALL elements that were moved (input AND button), not just the most prominent one. The AC said "path input + Browse + Scan section" — the Scan button is part of the section but was omitted from the order assertions. Read the AC literally: every named element in the spec needs its own `compareDocumentPosition` assertion.
