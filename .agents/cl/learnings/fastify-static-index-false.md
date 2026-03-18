---
scope: [backend]
files: [src/server/server-utils.ts]
issue: 423
date: 2026-03-17
---
`@fastify/static` with `index: false` prevents auto-serving index.html for directory requests, but still serves `/index.html` as an explicit file path. To intercept ALL HTML entry points for injection (nonce, config script), register explicit Fastify routes for `/`, `/index.html` (and prefixed variants) BEFORE `@fastify/static` — explicit routes take priority over the static file wildcard.
