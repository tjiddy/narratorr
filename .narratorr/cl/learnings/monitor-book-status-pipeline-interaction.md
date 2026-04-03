---
scope: [backend]
files: [src/server/jobs/monitor.ts, src/server/services/quality-gate-orchestrator.ts, src/server/utils/import-side-effects.ts]
issue: 324
date: 2026-04-03
---
Pre-promoting book status in the monitor (downloading → importing) requires three complementary guards: (1) quality gate held path must revert book back to downloading, (2) quality gate rejection path already reverts (no change), (3) import-start dedupe in `emitBookImporting` must skip when bookStatus is already 'importing' to prevent redundant SSE events. All three must be implemented together or the pipeline state becomes inconsistent.
