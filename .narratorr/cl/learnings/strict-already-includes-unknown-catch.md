---
scope: [backend, frontend, core]
files: [tsconfig.json, src/server/routes/search.ts]
issue: 188
date: 2026-03-28
---
TypeScript's `strict: true` already enables `useUnknownInCatchVariables` (since TS 4.4). Adding the explicit flag is a documentation/clarity step, not a behavior change — no new type errors surface. Always verify whether a "missing" compiler flag is already activated transitively via `strict` before designing an issue around enabling it.
