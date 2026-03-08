---
scope: [scope/core]
files: [src/core/download-clients/torrent-file-handoff.test.ts]
issue: 264
source: review
date: 2026-03-08
---
Reviewer caught that the qBittorrent torrent-file test swallowed exceptions with a try/catch and only asserted the upload format, not the returned hash. This left the `extractInfoHashFromTorrent` bug (F1) completely untested.

**Root cause:** Test was written to verify "multipart upload works" rather than "addDownload returns correct hash". The try/catch masked the real failure.

**Prevention:** Never swallow exceptions in tests. If a function returns a value, assert it. Test the full contract (upload + return value), not just one side effect.
