---
scope: [backend]
files: [src/server/services/merge.service.ts]
issue: 431
date: 2026-04-08
---
The deprecated `mergeBook()` method emitted `verifying` phase explicitly, but `executeMerge()` (used by `enqueueMerge`) delegated to `runStaging()` which did not emit it. Phase emissions that happen at different points in two code paths (legacy sync vs enqueue fire-and-forget) can silently diverge. When adding phase-dependent logic (like cancel gating), verify the phase is emitted in ALL paths that reach the gating point, not just the one you're testing against.
