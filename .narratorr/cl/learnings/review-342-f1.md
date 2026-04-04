---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 342
source: review
date: 2026-04-04
---
When changing a filter condition inside a callback (e.g., `mergeMatchResults` dropping duplicates → dropping only DB duplicates), a test that only verifies the input filtering (initial candidates) is insufficient. The merge side-effects (matchResult written, edited metadata seeded, selection state updated on confidence=none) also need direct assertions for the newly-admitted rows. The gap was that the test plan covered "mergeMatchResults applies match data" but the implementation only tested the candidates list, not the actual merge output.
