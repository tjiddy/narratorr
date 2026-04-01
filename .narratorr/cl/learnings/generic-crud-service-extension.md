---
scope: [backend]
files: [src/server/routes/crud-routes.ts, src/server/services/download-client.service.ts]
issue: 263
date: 2026-04-01
---
When extending a generic CRUD create to accept child records (e.g., pathMappings alongside a download client), modify the service's `create()` method to extract and delegate rather than overriding the route handler. The generic CRUD route calls `service.create(data)` with the full parsed body — so `create()` can destructure the extra field and call a specialized method like `createWithMappings()`. This avoids touching `crud-routes.ts` entirely and keeps the extension contained to the service layer.
