---
scope: [backend]
files: [src/server/routes/search.ts, src/server/plugins/error-handler.ts]
issue: 197
date: 2026-03-29
---
When a route has a manual try/catch for one error code (e.g., ACTIVE_DOWNLOAD_EXISTS → custom 409 body) and other codes should go through the error-handler plugin, explicitly re-throw the unhandled codes. The route's generic `return reply.status(500)` fallback intercepts typed errors before the plugin can see them. Pattern: check instanceof first, handle the special code, then `throw error` for the rest.
