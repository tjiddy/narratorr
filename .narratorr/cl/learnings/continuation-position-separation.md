---
scope: [backend]
files: [src/server/services/discovery-signals.ts, src/server/services/discovery-candidates.ts]
issue: 196
date: 2026-03-29
---
When separating a computed value (like continuation position) from a mixed array (missingPositions) into its own field, all consumers that filter or match against the array must be updated to also check the new field. In this case, `querySeriesCandidates` filtered results via `gap.missingPositions.includes(s.position)` — after moving the continuation out, a `|| s.position === gap.nextPosition` clause was needed to preserve the filtering behavior. Missing this would silently break series continuation suggestions.
