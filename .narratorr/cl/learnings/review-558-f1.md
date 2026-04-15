---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts]
issue: 558
source: review
date: 2026-04-15
---
When extracting retry logic into a shared utility, every request path in the adapter must go through it — not just the primary `request()` method. The qBittorrent `addDownloadFromFile()` method used `fetchWithTimeout` directly, bypassing retry/auth handling. The pattern to check: grep for all `fetchWithTimeout` calls in the adapter after migration and verify each one is wrapped by `requestWithRetry`.
