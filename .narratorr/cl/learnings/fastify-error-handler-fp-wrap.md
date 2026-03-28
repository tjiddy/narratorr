---
scope: [backend, services]
files: [src/server/plugins/error-handler.ts]
issue: 359
date: 2026-03-14
---
Fastify `setErrorHandler` registered via `app.register()` is scoped to that plugin's encapsulation boundary — routes registered outside that scope won't use it. Must wrap with `fastify-plugin` (fp) to break encapsulation. This caused all error handler tests to fail initially (errors returned 500 instead of mapped status codes).
