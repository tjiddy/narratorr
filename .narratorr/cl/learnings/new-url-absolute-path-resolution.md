---
scope: [scope/core, scope/backend]
files: [packages/core/src/download-clients/sabnzbd.ts]
issue: 197
date: 2026-02-23
---
`new URL('/api', 'http://host:port/prefix')` resolves to `http://host:port/api` — the absolute path `/api` replaces the base's path entirely. To preserve a URL base path prefix, use string concatenation (`${baseUrl}/api`) or `new URL('api', baseUrlWithTrailingSlash)` with a relative path (no leading slash). This is per the WHATWG URL spec and is a common gotcha when adding reverse proxy path support.
