---
scope: [backend, frontend]
files: [src/server/routes/search-stream.ts, src/client/hooks/useSearchStream.ts]
issue: 298
date: 2026-04-02
---
Per-request SSE streams (like search streaming) should NOT use the global EventBroadcasterService or add events to the shared `sseEventTypeSchema`. They use `reply.hijack()` + `reply.raw.write()` directly in the route handler, with their own event schemas. The global broadcast channel is for app-wide events (download progress, grab started, etc.) that all connected clients receive.
