---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts]
issue: 264
date: 2026-03-08
---
qBittorrent's `request()` method returns `undefined` for empty response bodies and throws on non-JSON responses. When mocking qBittorrent endpoints in tests, return empty string `''` for success-with-no-data (e.g., torrents/add), not `'Ok.'` — the latter triggers JSON.parse failure.
