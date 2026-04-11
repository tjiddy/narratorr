---
scope: [backend, core]
files: []
date: 2026-04-10
---
`new URL('/api', 'http://host:port/prefix/')` resolves to `http://host:port/api` — the absolute path `/api` replaces the base's entire path. To preserve a base path prefix (e.g., reverse proxy), use a relative path without the leading slash: `new URL('api', baseUrlWithTrailingSlash)` or string concatenation `${baseUrl}/api`. Per the WHATWG URL spec.
