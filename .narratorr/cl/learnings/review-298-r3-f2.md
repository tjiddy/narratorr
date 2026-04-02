---
scope: [scope/backend]
files: [src/server/routes/search-stream.test.ts]
issue: 298
source: review
date: 2026-04-02
---
SSE route tests used only mocked request/reply objects (direct handler call pattern from the `fastify-sse-hijack-testing` learning). While necessary for the SSE stream itself, auth enforcement and schema parsing can and should be tested via `app.inject()` — auth rejects before hijack runs. Future: for new SSE routes, add both direct handler tests (for SSE behavior) and inject tests (for auth + schema).
