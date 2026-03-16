---
scope: [backend]
files: [src/server/routes/events.test.ts]
issue: 283
source: review
date: 2026-03-10
---
SSE endpoints that use `reply.hijack()` can't be tested with `app.inject()` for the happy path (it hangs forever). But the auth *rejection* case (401) works fine with inject because the auth plugin sends the response before the route handler runs. For SSE auth testing: test the 401/rejection case via inject with the auth plugin registered, and test the handler logic separately via mock objects. This covers both the auth integration and the SSE behavior without hanging.
