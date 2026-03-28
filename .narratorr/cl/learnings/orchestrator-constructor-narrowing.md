---
scope: [scope/backend, scope/services]
files: [src/server/services/quality-gate.service.ts, src/server/routes/index.ts]
issue: 435
date: 2026-03-18
---
When narrowing a service constructor (removing deps that move to orchestrator), the biggest test impact is on fixture types — baseDownload/baseBook fixtures that were passed through mockDbChain (untyped) now go through processDownload() (typed), requiring all schema fields to be present. Missing fields like progressUpdatedAt, monitorForUpgrades, importListId cause TS errors. Keep a complete fixture template per schema type to avoid this churn.
