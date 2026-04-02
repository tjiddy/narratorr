---
scope: [backend, core]
files: [src/server/services/quality-gate-orchestrator.ts, src/server/services/import.service.ts]
issue: 299
date: 2026-04-02
---
Seed time boundary uses strictly-less-than (`elapsedMs < minSeedMs`) for deferral, meaning exactly-at-threshold does NOT defer. This matches the import service pattern but test titles must be precise — "at boundary" means "removed immediately" not "deferred." The spec's wording "strictly less-than" maps directly to the `<` operator.
