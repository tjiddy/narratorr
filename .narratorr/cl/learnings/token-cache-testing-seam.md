---
scope: [backend]
files: [scripts/lib.ts, scripts/lib.test.ts]
issue: 139
date: 2026-03-26
---
`scripts/lib.ts` exports `_tokenCache` specifically as a testing seam for `getGhToken()`. Pre-populate it with `_tokenCache.set(appId, { token: 'test-token', expiresAt: Date.now() + 10*60*1000 })` AND set `GH_APP_ID`, `GH_INSTALLATION_ID`, `GH_APP_PRIVATE_KEY` env vars to make `getGhToken()` return the cached token without any JWT or HTTP calls. This avoids the need to mock `node:fs`, `node:crypto`, or `fetch`.
