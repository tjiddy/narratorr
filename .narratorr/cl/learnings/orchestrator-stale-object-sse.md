---
scope: [scope/backend, scope/services]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 435
date: 2026-03-18
---
When an orchestrator batch loop queries objects then modifies their status via service calls, the original objects become stale. SSE emissions must use the statusTransition returned by the service, NOT the stale object's status field. Self-review caught this: auto-reject emitted old_status='completed' (from initial query) instead of 'checking' (after atomicClaim). Fix: pass statusTransition.from explicitly to cleanup methods instead of reading download.status.
