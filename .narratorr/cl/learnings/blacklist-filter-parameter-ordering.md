---
scope: [backend, services]
files: [src/server/services/search-pipeline.ts, src/server/jobs/search.ts]
issue: 406
date: 2026-04-07
---
When adding a required parameter to a shared function like `searchAndGrabForBook`, inserting it before optional parameters (e.g., `blacklistService` before `broadcaster?`) changes the positional meaning of all existing call sites. Blast radius includes every test file that calls the function or any wrapper function in the chain. Grep for the function name across all `*.test.ts` files early to estimate the update scope before starting.
