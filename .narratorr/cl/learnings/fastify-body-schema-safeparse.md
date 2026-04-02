---
scope: [backend]
files: [src/server/routes/activity.ts]
issue: 301
date: 2026-04-02
---
Fastify's built-in JSON Schema validation (via `schema: { body: zodSchema }`) can reject empty POST bodies with 400 when the Zod schema uses `.optional().default({})`. Using `safeParse` in the handler with a fallback is more resilient — it handles missing/malformed bodies gracefully without Fastify's pre-validation blocking the request.
