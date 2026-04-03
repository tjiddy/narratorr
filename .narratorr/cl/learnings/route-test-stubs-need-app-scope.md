---
scope: [backend]
files: [src/server/routes/system.test.ts]
issue: 313
date: 2026-04-03
---
Test stubs for route files must be placed inside the `describe` block that has `app` and `services` in scope (via `beforeAll`). Standalone `describe` blocks at the top level lack access to the Fastify test app and mock services, causing all tests to fail with undefined references. The `system.test.ts` file has two top-level describes — one for standard routes and one for multipart-specific routes — so stubs must target the correct parent.
