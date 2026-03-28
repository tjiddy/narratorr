---
scope: [backend]
files: [src/server/plugins/helmet-options.ts, src/server/index.ts]
issue: 423
date: 2026-03-17
---
`@fastify/helmet` has built-in nonce support via `enableCSPNonces: true` — it generates `reply.cspNonce.script` (16-byte hex) per-request and auto-appends `'nonce-<value>'` to the CSP scriptSrc directive. No need to manually generate nonces or modify CSP headers. Just enable the option and use `reply.cspNonce.script` in HTML injection.
