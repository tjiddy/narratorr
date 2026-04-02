---
scope: [backend, core]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 299
source: review
date: 2026-04-02
---
When a retry loop clears a field (outputPath) on partial failure, the next cycle must treat null as "already done" not "nothing to do." The original `deferredDeleteFiles` returned false for null outputPath, which meant a retry after adapter-failure could never complete. Multi-cycle state machines need explicit handling for the "already-cleaned" state at each step. A two-cycle integration test (cycle 1: partial failure, cycle 2: retry) would have caught this.
