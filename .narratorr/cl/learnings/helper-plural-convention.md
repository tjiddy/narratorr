---
scope: [backend]
files: [src/server/services/import-orchestration.helpers.ts, src/server/services/enrichment-orchestration.helpers.ts, src/server/services/quality-gate-deferred-cleanup.helpers.ts]
issue: 586
date: 2026-04-15
---
Helper files in `src/server/services/` must use the plural `.helpers.ts` suffix, not `.helper.ts`. The singular form was introduced by #552's extraction pattern and went unnoticed until this sweep caught 3 instances. Future extractions should follow the plural convention from the start.
