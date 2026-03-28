---
scope: [scope/backend]
files: [src/shared/schemas/enrichment.ts, src/shared/schemas/book.ts]
issue: 431
date: 2026-03-17
---
Found a pre-existing typecheck failure on main: duplicate enrichmentStatusSchema exports from both book.ts and enrichment.ts, both re-exported via the barrel schemas.ts. Fixed by making enrichment.ts re-export from book.ts. When verify.ts fails, always check if the failure exists on main before debugging — saves wasted cycles.
