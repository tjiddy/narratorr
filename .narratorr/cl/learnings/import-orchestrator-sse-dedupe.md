---
scope: [backend]
files: [src/server/services/import-orchestrator.ts, src/server/utils/import-side-effects.ts]
issue: 525
date: 2026-04-13
---
`ImportOrchestrator.importDownload()` skips the `download_status_change` SSE when `ctx.downloadStatus === 'importing'` (line 50). Any code path that sets status to `importing` before calling `importDownload()` (like the CAS claim in `drainQueuedImports`) must emit the SSE explicitly or clients won't see the transition. This is the "approve-path dedupe" — originally designed for the approve route which also sets status before calling the orchestrator.
