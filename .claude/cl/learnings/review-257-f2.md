---
scope: [backend]
files: [apps/narratorr/src/server/routes/*.ts]
issue: 257
source: review
date: 2026-03-05
---
Fastify route-level generics (`app.get<{ Params: IdParam }>()`) work with plain `FastifyInstance` — you don't need `FastifyInstance<ZodTypeProvider>` to get typed request properties. The codebase already had an example at `remote-path-mappings.ts:10`. I incorrectly disputed the reviewer's finding, believing a global refactor was needed. Should have checked existing patterns in the codebase before disputing. The fix was mechanical — just add the generic type params and drop the `as` casts.
