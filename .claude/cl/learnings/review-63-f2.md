---
scope: [backend, services]
files: [src/server/services/download.service.ts, src/server/__tests__/search-grab-flow.e2e.test.ts]
issue: 63
source: review
date: 2026-03-24
---
When a spec says "cancel-then-grab: if cancel succeeds but grab fails, book should revert to wanted", the cancel must update the book status to `wanted` before the grab attempt — not rely on the orchestrator's rollback path. The orchestrator's `cancel()` does the revert but `DownloadService.grab()` calls `DownloadService.cancel()` directly (bypassing orchestrator). Rule: whenever a flow that changes state (cancel) bypasses the normal rollback path, it must set the book to its expected recovery state before the next irreversible step.
