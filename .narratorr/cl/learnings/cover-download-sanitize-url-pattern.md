---
scope: [backend, services]
files: [src/server/services/cover-download.ts, src/server/utils/sanitize-log-url.ts]
issue: 622
date: 2026-04-17
---
When adding `sanitizeLogUrl()` to new log sites, the test pattern is: seed a URL with `?apikey=secret`, trigger the error path, then assert `log.warn` payload's `url` field equals `origin + pathname` (no query/hash) and does not contain the secret. Also test userinfo credentials (`user:pass@host`) since `sanitizeLogUrl` strips those via `new URL().origin + pathname`. SpyOn `AbortSignal.timeout` to verify timeout constant flow-through without disrupting MSW-based integration tests.
