---
scope: [backend]
files: [src/server/services/match-job.service.ts]
issue: 335
date: 2026-04-04
---
The `scored[]` array passed to `resolveConfidenceFromDuration` already carries `.score` from `scoreResult()` — no signature change or additional computation needed to add score-based logic. The data flows through `rankResults()` → `scored` → `resolveConfidenceFromDuration` without modification.
