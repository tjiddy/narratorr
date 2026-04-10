---
scope: [backend, core]
files: [src/core/utils/collect-audio-files.ts, src/core/utils/audio-processor.ts, src/server/utils/import-helpers.ts]
issue: 409
source: review
date: 2026-04-10
---
When a review finding requires restoring original behavior, don't simply back out the consolidation — that satisfies the regression fix but drops the structural AC. Instead, parameterize the shared function to support all the original sort contracts. The F1 fix restored sort semantics by reverting to local wrappers, which the F2 reviewer correctly flagged as no longer satisfying the "consolidated into parameterized variants" AC. The right approach was always to add a `sort` mode parameter to `collectSortedAudioFiles`.
