---
scope: [backend, frontend, core]
files: [apps/narratorr/src/shared/schemas.ts]
issue: 294
date: 2026-03-06
---
With `moduleResolution: "bundler"`, `./foo.js` resolves to `./foo.ts` but NOT `./foo/index.ts`. When converting a file to a directory with an index barrel, the import must change to `./foo/index.js` (explicit) — `./foo.js` will fail with "Cannot find module". This bit us when splitting `settings.ts` into `settings/index.ts`.
