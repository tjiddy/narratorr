---
scope: [backend, services]
files: [src/server/utils/import-steps.ts, src/server/services/import-orchestrator.ts]
issue: 436
date: 2026-03-17
---
handleImportFailure mixed core cleanup (rm files, revert DB) with fire-and-forget side effects (SSE, notification, event recording). When extracting side effects to an orchestrator, the failure handler needs to be split first — otherwise the orchestrator can't dispatch failure-path side effects because the service already did them internally. Split the handler into core-cleanup-only + separate side-effect exports so the orchestrator catches the rethrow and dispatches failure side effects independently.
