---
scope: [backend]
files: [src/server/routes/activity.ts]
issue: 268
date: 2026-03-09
---
Fastify with Zod body schema validation rejects POST requests with no body (returns 400). For endpoints where the body is entirely optional (like reject with optional reason), don't use a Zod body schema — parse `request.body` manually with type assertion instead.
