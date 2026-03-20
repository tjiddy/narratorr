---
scope: [backend]
files: [src/server/plugins/helmet-options.ts, src/server/plugins/helmet.test.ts]
issue: 16
date: 2026-03-20
---
When `enableCSPNonces: true` is set in @fastify/helmet, the library injects a per-request nonce into ALL directives that contain `'self'` — including `style-src`. This means the actual CSP header reads `style-src 'self' https://fonts.googleapis.com 'nonce-abc123'` even though the config only specifies `["'self'", 'https://fonts.googleapis.com']`. Tests asserting exact `style-src` substrings must not include the nonce value, which is fine since `toContain()` does substring matching.
