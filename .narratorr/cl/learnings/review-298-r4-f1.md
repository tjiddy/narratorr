---
scope: [scope/backend]
files: [src/server/routes/search-stream.test.ts]
issue: 298
source: review
date: 2026-04-02
---
The reviewer asked for an `app.inject()` test for the successful SSE GET path with valid API key and zero enabled indexers. Prior rounds only added inject for auth rejection (401) and cancel routes. The successful SSE path uses `reply.hijack()` which causes `app.inject()` to hang (per `fastify-sse-hijack-testing` learning), so the fix used `app.listen(0)` + real HTTP `fetch()` instead. This proves the full Fastify stack (auth, schema, route registration) while handling the hijacked SSE stream. Lesson: for SSE routes, always add both direct handler tests (for SSE behavior) AND real HTTP integration tests (for auth + schema + route registration). The auth rejection tests work with inject, but the successful path requires a real HTTP connection.
