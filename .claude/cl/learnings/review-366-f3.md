---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.ts]
issue: 366
source: review
date: 2026-03-16
---
Candidate exclusion implemented ASIN-only matching but the spec explicitly required "ASIN match OR title+author fuzzy match." The existing `diceCoefficient` utility in `src/core/utils/similarity.ts` was available but not used. When implementing duplicate detection, always read the spec's "OR" conditions carefully — ASIN-only is the happy path but fuzzy matching catches the real-world case of books with different/missing ASINs.
