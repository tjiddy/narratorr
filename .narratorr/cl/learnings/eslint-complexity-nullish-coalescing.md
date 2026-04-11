---
scope: [backend, frontend]
files: [src/server/services/library-scan.service.ts, src/client/pages/library/useLibraryPageState.ts]
issue: 470
date: 2026-04-11
---
ESLint's `complexity` rule counts `??` (nullish coalescing) and `||` operators as branches, same as `if/else`. Functions with heavy nullable field coalescing (e.g., building event payloads from metadata with 8+ optional fields) report complexity 15-23 even when the logic is linear. Extracting the "real" branching (enrichment calls, copy/move) doesn't reduce the metric because the coalescing operators remain. When estimating suppression removal feasibility, count `??` and `||` operators in the target function — each one adds 1 to cyclomatic complexity.
