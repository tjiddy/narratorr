---
scope: [scope/core]
files: [src/core/utils/download-url.ts]
issue: 527
source: review
date: 2026-04-13
---
Node's undici `fetch` wraps DNS/connection failures as `TypeError('fetch failed')` with the real errno on `error.cause.code`, not `error.code`. The existing `mapNetworkError()` utility in `fetch-with-timeout.ts` already handles this, but the new resolver's `sanitizeNetworkError()` only inspected top-level `.code`. Tests used plain `Error` objects instead of the real undici shape, so they didn't catch the gap. When writing network error sanitization, always check `error.cause?.code` for the undici wrapper pattern, and use `TypeError('fetch failed', { cause })` fixtures in tests.
