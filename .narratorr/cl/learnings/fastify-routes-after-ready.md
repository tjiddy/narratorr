---
scope: [backend]
files: [src/server/plugins/auth.plugin.test.ts]
issue: 284
date: 2026-03-09
---
Fastify routes registered after `app.ready()` are not properly wired — hooks (like auth) won't fire for them, and they may not appear in the routing tree. In test helpers that use `createApp()` patterns, always accept an optional `extraRoutes` callback parameter that runs BEFORE `app.ready()`, rather than registering routes inline in each test after the app is created.
