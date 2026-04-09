---
scope: [backend]
files: [src/server/routes/books.test.ts, src/server/routes/system.test.ts]
issue: 445
date: 2026-04-09
---
Multipart route tests require a SEPARATE top-level `describe` block with a custom Fastify app that registers `@fastify/multipart` BEFORE routes. The base `createTestApp` helper does NOT register multipart. Pattern: build raw Fastify instance, register multipart, then `registerRoutes()`. Use `createMultipartPayload()` helper to build raw boundary payloads for `inject()`. See system.test.ts lines 625-705 for the canonical pattern.
