---
scope: [backend]
files: [src/server/routes/index.ts, src/server/routes/index.test.ts]
issue: 430
date: 2026-03-18
---
To test registerRoutes (which iterates a module-level routeRegistry array), mutate the exported array in-place with spies, then restore in a try/finally. This works because the for...of loop references the same array object. The pattern: snapshot originals, replace with spies, call the function, assert, restore.
