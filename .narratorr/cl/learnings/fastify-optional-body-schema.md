---
scope: [backend]
files: [src/server/routes/discover.ts]
issue: 501
date: 2026-04-12
---
Fastify with zod body schema rejects POST requests with no body (returns 400), even when the schema has `.optional().default({})`. To support both no-body and with-body requests on the same endpoint, remove the body from the Fastify schema definition and validate manually with `addBodySchema.safeParse(request.body ?? {})` in the handler. This avoids the Fastify content-type enforcement while still getting Zod validation for invalid payloads.
