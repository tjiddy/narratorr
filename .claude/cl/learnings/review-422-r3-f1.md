---
scope: [scope/backend, scope/services]
files: [src/server/services/quality-gate.service.ts]
issue: 422
source: review
date: 2026-03-17
---
Reviewer caught that the quality-gate service still measured 455 code lines after the initial extraction, missing the AC1 target of <400. The initial extraction (emitSSE helper, performRejectionCleanup) wasn't aggressive enough — types/constants and the pure quality assessment logic should have been extracted to separate co-located files. When an AC has a numeric target (line count, coverage %), verify it with the actual measurement tool (ESLint max-lines) before declaring done, not just eyeballing.
