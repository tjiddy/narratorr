---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.ts, src/server/jobs/monitor.ts]
issue: 358
date: 2026-04-05
---
When moving book status promotion from monitor to processOneDownload, the in-memory book object must be mutated after the DB write — otherwise revert guards in holdForProbeFailure and dispatchSideEffects (which check `book.status === 'importing'`) won't fire, leaving the book stuck in 'importing' on hold/reject. This is because the book row is loaded before the atomic claim, so it has stale status.