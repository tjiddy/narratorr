---
scope: [scope/db]
files: [src/db/schema.ts, src/server/jobs/monitor.ts, src/server/services/quality-gate.service.ts]
issue: 354
source: spec-review
date: 2026-03-14
---
Spec claimed `downloads.externalId` index was needed because "monitor job cross-references by externalId", but the reviewer verified that `monitor.ts` iterates downloads in-memory and passes `externalId` to adapters — no selective DB query exists. The only DB `eq()` on `externalId` is a tautology bug (`eq(col, col)`). The `/elaborate` step accepted the debt scan finding at face value without verifying the actual query patterns. Fix: when adding performance indexes, always trace the claimed query to actual source code and confirm it's a selective DB lookup, not an in-memory operation.
