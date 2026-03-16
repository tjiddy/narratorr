---
scope: [scope/services]
files: []
issue: 349
source: spec-review
date: 2026-03-15
---
The extracted-phase context contract listed `downloadId` but the torrent-removal phase calls `handleTorrentRemoval(download, minSeedTime)` which needs the full `DownloadRow` (specifically `downloadClientId`, `externalId`, `completedAt`, `id`). The round-1 response defined the context contract without reading the `handleTorrentRemoval` signature and its field usage at lines 589-610. When defining a shared context for extracted phases, trace every phase's call surface to verify the context provides all required data — don't assume a foreign key ID is sufficient when the phase may need the full row.
