---
scope: [frontend]
files: [src/client/pages/library/helpers.ts]
issue: 266
source: review
date: 2026-04-01
---
When adding a secondary sort comparison that should only apply within a group (same series name), guard it with a null-check on the grouping field. Also, always add an explicit id fallback as the final tiebreaker in client-side sort comparators — relying on Array.sort stability for equal-position ordering doesn't match the backend's deterministic id tiebreaker contract.
