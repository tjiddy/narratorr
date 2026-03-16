---
scope: [scope/backend, scope/frontend, scope/api]
files: [src/server/index.ts, src/client/lib/api/client.ts, package.json]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec assumed multipart file upload would "just work" without verifying that (a) `@fastify/multipart` isn't installed, (b) the server has no multipart plugin registered, and (c) the client's `fetchApi()` forces `Content-Type: application/json` on all requests with a body. Any feature involving file uploads needs to explicitly scope the transport plumbing (server plugin, client helper, dependency installation) as part of the AC.
