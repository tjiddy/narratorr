---
scope: [backend]
files: [src/server/services/import.service.ts, src/server/services/import.service.test.ts]
issue: 318
date: 2026-04-03
---
When testing `handleTorrentRemoval()` via `importDownload()`, `adapter.getDownload()` is called twice: first by `resolveSavePath()` (needs full DownloadItemInfo with savePath/name) and then by `handleTorrentRemoval()` (needs ratio). Test mocks must chain two `mockResolvedValueOnce` calls — the first with the full adapter response for path resolution, the second with the desired ratio for the removal check. Using a single `mockResolvedValueOnce({ ratio: 0.5 })` gets consumed by `resolveSavePath` and crashes on missing `savePath`.
