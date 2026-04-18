---
scope: [backend, services]
files: [src/server/services/import-adapters/manual.ts]
issue: 636
source: review
date: 2026-04-18
---
ManualImportAdapter.process() had no local try/catch, so failures only triggered ImportQueueWorker.markJobFailed() which sets job+book to failed but doesn't emit SSE or record events. The old confirmImport handler had these failure side effects. When migrating a function to an adapter pattern, audit both the success AND failure paths of the original — side effects in catch blocks are easy to miss when only the happy path is visible.
