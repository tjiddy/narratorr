---
scope: [scope/backend, scope/services]
files: [src/server/services/import.service.ts]
issue: 361
source: spec-review
date: 2026-03-15
---
Spec review caught that the AC lumped awaited-but-nonfatal steps (old path cleanup, tag embedding) together with truly fire-and-forget work (notifier, event history). The distinction matters: awaited steps have ordering guarantees that tests assert, and an implementer following "fire-and-forget" literally could detach them and break sequencing.

Root cause: `/elaborate` recognized that these steps catch errors individually and continue, but didn't distinguish between `await fn().catch()` (awaited, ordered) and `fn().catch()` (detached, unordered). Both "continue on failure" but have different sequencing contracts.

Prevention: When describing error-handling semantics, distinguish between "awaited with catch" (ordered, nonfatal) and "detached with .catch()" (fire-and-forget). Check whether tests assert ordering between the steps.
