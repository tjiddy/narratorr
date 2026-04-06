---
scope: [backend, core]
files: [src/core/utils/fetch-with-timeout.ts, src/server/services/cover-download.ts]
issue: 369
date: 2026-04-06
---
`fetchWithTimeout` uses `redirect: 'manual'` and throws on 3xx — it's designed for API/service calls where redirects indicate auth proxy issues. CDN image downloads legitimately redirect (e.g., CloudFront → S3), so cover downloads must use native `fetch` with `redirect: 'follow'`. This was caught during spec review — always check shared helpers' redirect behavior before reusing them for new HTTP use cases.
