---
scope: [backend]
files: [src/server/jobs/monitor.ts]
issue: 537
source: review
date: 2026-04-13
---
The monitor job has its own failure paths (handleMissingItem, handleFailureTransition) that bypass the orchestrator entirely — they update the DB directly. When adding event recording to the orchestrator's setError/cancel, the monitor's parallel failure paths were missed because we only searched for orchestrator.setError callers, not all code paths that set downloads to 'failed'. Should have grepped for `status: 'failed'` across all of `src/server/` to find every failure path.
