---
scope: [scope/backend, scope/db]
files: [src/server/services/download.service.ts, src/server/jobs/monitor.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
When adding a new column that tracks "when field X last changed," all existing writers of field X must be enumerated and updated. The spec only covered monitorDownloads() but missed DownloadService.updateProgress() — another code path that mutates progress. Always grep for all assignment sites of the tracked field before finalizing the writer list.
