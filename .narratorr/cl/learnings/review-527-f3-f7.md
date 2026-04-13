---
scope: [scope/core]
files: [src/core/download-clients/qbittorrent.ts, src/core/download-clients/transmission.ts, src/core/download-clients/deluge.ts, src/core/download-clients/sabnzbd.ts, src/core/download-clients/nzbget.ts]
issue: 527
source: review
date: 2026-04-13
---
When adding protocol guard branches to adapter `addDownload()` methods (e.g., torrent clients rejecting `nzb-url`, usenet clients rejecting `torrent-bytes`/`magnet-uri`), every new rejection branch must have a dedicated negative test. The test should pass the unsupported artifact type and assert both the error message AND that no downstream API call is made. Success-path-only suites won't catch regressions if the guard is accidentally removed.
