---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts, src/core/download-clients/qbittorrent.test.ts]
issue: 24
date: 2026-03-20
---
qBittorrent's `/api/v2/app/version` returns bare plain text (e.g., `v5.0.3`), not JSON — making it the only known endpoint in the adapter that doesn't return JSON. When fixing this, scope the change to the calling method only (not the shared `request()` helper), mirroring the `doLogin()` pattern of fetching directly with `fetchWithTimeout` + `response.text()` and sending `Cookie`/`Referer` headers manually. Broadening `request()` to accept non-JSON would silently break `getCategories()` (`Object.keys(...)` on a string returns character indexes) and mutation endpoints that ignore return values.
