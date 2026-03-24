---
scope: [backend]
files: [apps/narratorr/src/server/plugins/auth.ts, apps/narratorr/src/server/routes/auth.ts]
issue: 168
date: 2026-02-23
---
Casting `FastifyRequest` directly to `Record<string, unknown>` fails TypeScript strict mode (TS2352). Must cast through `unknown` first: `(request as unknown as Record<string, unknown>).user`. This is because FastifyRequest's index signature doesn't overlap with Record's. The same pattern applies to any Fastify type cast to a generic record.
