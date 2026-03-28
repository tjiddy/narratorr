---
scope: [backend]
files: [src/server/routes/events.ts, src/server/routes/events.test.ts]
issue: 283
date: 2026-03-10
---
Fastify's `app.inject()` hangs indefinitely on SSE endpoints because `reply.hijack()` keeps the connection open and inject waits for the response to end. Solution: test the route handler function directly by capturing it via a mock app object, then calling it with mock request/reply objects. This avoids the inject timeout entirely.
