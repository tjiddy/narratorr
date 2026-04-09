---
scope: [backend]
files: [src/server/services/match-job.service.ts]
issue: 447
date: 2026-04-09
---
When fixing swap-retry behavior, audit ALL downstream consumers of the search context — not just the one that surfaced the bug. In #447, both `rankResults()` and the title similarity floor used the misparsed context. The spec review caught that `rankResults()` was also affected (F2 finding). Any future swap-retry-dependent logic must also receive the swapped context.
