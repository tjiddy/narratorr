---
scope: [backend]
files: [src/server/plugins/error-handler.ts, src/server/routes/books.ts]
issue: 466
date: 2026-04-11
---
When moving a domain error into `ERROR_REGISTRY`, the route's manual try/catch can be fully removed — existing route tests pass unchanged because they mock the service to throw the typed error, and the error handler plugin maps it identically. The only observable change is the generic 500 body: route-specific messages like `"Failed to upload cover"` become the standard `"Internal server error"` from the plugin. Existing 500 tests that only assert `statusCode` (not body) need no update.
