---
scope: [backend]
files: [src/server/services/search-pipeline.ts, src/server/routes/search.ts, src/server/routes/search-stream.ts]
issue: 395
date: 2026-04-07
---
`postProcessSearchResults()` had no logger parameter despite being the shared post-processing pipeline for interactive search routes. Adding a logger required updating the function signature and both caller sites (search.ts, search-stream.ts). The route tests mock `postProcessSearchResults` entirely so they didn't need updates, but future changes to the function signature will require checking all callers including test mocks.
