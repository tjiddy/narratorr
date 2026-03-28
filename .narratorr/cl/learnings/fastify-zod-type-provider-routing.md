---
scope: [backend]
files: [apps/narratorr/src/server/routes/*.ts]
issue: 257
date: 2026-03-05
---
Fastify route functions take plain `FastifyInstance`, not `FastifyInstance<ZodTypeProvider>`. Even with `fastify-type-provider-zod` registered and schemas attached to routes, `request.body`/`request.query`/`request.params` are typed as `unknown` inside route handlers. `as` casts are still needed for TypeScript — but they're now safe (validated by Zod before the handler runs) rather than unsafe (blind trust). A full fix would require typing route functions with the provider generic, but that's a broader refactor.
