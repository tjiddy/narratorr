---
scope: [backend, api]
files: [src/server/routes/activity.ts, src/server/routes/discover.ts]
issue: 149
date: 2026-03-26
---
`return await` is context-dependent: REQUIRED inside try/catch (so the catch block sees rejections), FORBIDDEN outside try/catch (ESLint `@typescript-eslint/return-await` flags it as redundant). When removing a try/catch block from a route handler, strip the `await` from any `return await reply.status(...)` or `return await service.method()` calls in the same block.
