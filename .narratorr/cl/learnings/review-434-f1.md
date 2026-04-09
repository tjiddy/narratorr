---
scope: [scope/core, scope/services]
files: [src/server/services/match-job.service.ts, src/server/services/import.service.ts, src/server/services/library-scan.service.ts, src/server/services/quality-gate-orchestrator.ts, src/server/services/merge.service.ts, src/server/services/bulk-operation.service.ts]
issue: 434
source: review
date: 2026-04-09
---
Reviewer caught that new ffprobePath derivation sites used raw truthiness (`ffmpegPath ? ...`) instead of `.trim()`, allowing whitespace-only settings values to enable ffprobe spuriously. The settings schema only validates/trims when `processing.enabled` is true, so disabled configs can contain whitespace-only paths.

Missed because: the spec mentioned `.trim()` in the ZOD-1 gotcha but the implementation pattern was copied from a template that didn't need trimming. When threading a setting value through multiple call sites, the trim guard must be applied at every derivation point — not just at schema validation.

Prevention: when using a settings string to derive another value, always apply `.trim()` before the truthiness check, matching the project's ZOD-1 convention.
