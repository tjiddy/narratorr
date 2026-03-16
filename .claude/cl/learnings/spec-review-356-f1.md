---
scope: [scope/backend, scope/services]
files: [src/server/services/library-scan.service.ts]
issue: 356
source: spec-review
date: 2026-03-14
---
Spec review caught that AC1 (full-table prefetch) and AC4 (>999 chunking) described incompatible batching strategies for the same code path. Full-table prefetch doesn't use `IN(...)` so chunking is irrelevant. The elaboration skill added a generic "chunk at 999" AC without analyzing whether each specific fix actually uses `IN(...)`. When writing chunking/batching ACs, specify which query shape each fix uses and only apply chunking requirements to `IN(...)` patterns.
