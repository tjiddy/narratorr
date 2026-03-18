---
scope: [backend, services]
files: [src/server/utils/import-steps.ts, src/server/utils/import-side-effects.ts]
issue: 436
date: 2026-03-17
---
Adding new exports (emitDownloadImporting, emitBookImporting, failure-path functions) to import-steps.ts pushed it over the 400-line lint limit. When splitting helpers during an extraction refactor, anticipate the line count impact and extract to a new co-located file proactively rather than discovering it at the verify step. Re-exports from the original file preserve backwards compatibility without changing existing importers.
