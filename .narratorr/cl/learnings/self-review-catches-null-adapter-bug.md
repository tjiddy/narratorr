---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 318
date: 2026-04-03
---
The self-review step caught a non-null assertion (`adapter!.removeDownload()`) in `cleanupDeferredImports()` that would crash when `adapter` was null (e.g., client deleted between import and cleanup cycle). Also caught a missing `deleteAfterImport` guard that the quality-gate orchestrator had but the import service didn't. Self-review paying for itself — these would have been blocking PR review findings.
