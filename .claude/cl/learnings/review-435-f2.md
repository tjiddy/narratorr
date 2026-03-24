---
scope: [scope/backend, scope/services]
files: [src/server/services/quality-gate-orchestrator.test.ts]
issue: 435
source: review
date: 2026-03-18
---
When extracting rejection cleanup to an orchestrator, every failure path in the cleanup chain needs a test — not just the fire-and-forget ones. The self-review caught the stale SSE status bug but missed the revertBookStatus failure contract change because the test suite only covered blacklist/deletion/SSE failures (fire-and-forget) and not revertBookStatus failure (propagating). The gap: no test asserted what happens when the LAST step in cleanup fails.
