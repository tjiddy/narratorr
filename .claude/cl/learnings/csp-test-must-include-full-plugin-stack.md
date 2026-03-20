---
scope: [backend]
files: [src/server/plugins/helmet.test.ts, src/server/plugins/csp-nonce-strip.ts]
issue: 21
date: 2026-03-20
---
When testing CSP header content, the test app must register the full production plugin stack — not just helmet alone. helmet.test.ts used `createApp()` with only `@fastify/helmet` registered, so the semantic assertion (style-src must not have a nonce) correctly failed before implementation, but for the right reason: the strip plugin wasn't present. The fix was to add `await app.register(cspNonceStripPlugin)` to the test app. Without this, a semantic test that passes would give false confidence — it would only prove helmet's raw output, not the production-sent header.
