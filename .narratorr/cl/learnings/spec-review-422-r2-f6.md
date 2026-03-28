---
scope: [scope/backend, scope/services]
files: []
issue: 422
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC3 named `system.ts` as a consumer of the `searchAndGrabForBook` re-export from `jobs/search.ts`, but `system.ts` only imports `runSearchJob` and `searchAllWanted`. The actual consumer (`books.ts`) already imports directly from `search-pipeline.ts`. The spec asserted a consumer migration that didn't need to happen. Root cause: copied the consumer claim from the original issue discovery notes without verifying with `rg`. Prevention: always run a repo-wide search for the symbol before naming specific consumer files in AC/test plan items.
