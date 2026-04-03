---
scope: [backend, services]
files: [src/server/services/download-orchestrator.ts, src/server/services/download.service.ts]
issue: 315
date: 2026-04-03
---
`DownloadService.cancel()` is called internally by `grab(replaceExisting: true)` for replacement downloads. Adding side-effect behavior (like blacklisting) to `DownloadService.cancel()` would silently change the replacement flow. User-facing side effects belong in the orchestrator, which is only called from routes. This was caught during spec review — checking internal callers of a method before adding behavior to it prevents scope leaks.
