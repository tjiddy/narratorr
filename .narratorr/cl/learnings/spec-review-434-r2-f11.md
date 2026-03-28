---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec claimed cancel() returns "download + book state" and updateStatus() "returns state needed by orchestrator", but actual signatures are `Promise<boolean>` and `Promise<void>`. When writing orchestrator specs, read method signatures to determine what context is available post-call vs what must be prefetched. The ImportOrchestrator pattern uses prefetch — state this explicitly.
