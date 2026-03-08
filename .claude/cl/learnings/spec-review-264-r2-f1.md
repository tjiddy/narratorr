---
scope: [scope/backend, scope/core]
files: []
issue: 264
source: spec-review
date: 2026-03-08
---
Spec claimed `data:` URI download URLs would work with "existing grab pipeline unchanged," but the qBittorrent adapter explicitly rejects non-magnet URIs (line 150-154). The spec missed this because it didn't verify the adapter input contracts — only the indexer output format. When designing a new data flow that crosses module boundaries, verify the receiving side's input contract, not just the sending side's output format. The fix was to extend the adapter interface with `torrentFile: Buffer` and have `DownloadService.grab` bridge `data:` URIs to native file-upload APIs on each torrent client.
