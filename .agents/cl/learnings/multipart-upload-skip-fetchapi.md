---
scope: [frontend, api]
files: [src/client/lib/api/backups.ts, src/client/lib/api/client.ts]
issue: 280
date: 2026-03-10
---
The `fetchApi()` helper auto-sets `Content-Type: application/json` for requests with a body. For multipart file uploads, you must bypass `fetchApi()` entirely and use `fetch()` directly with FormData — the browser needs to set its own `Content-Type` with the multipart boundary. Using `fetchApi()` for file uploads would corrupt the request.
