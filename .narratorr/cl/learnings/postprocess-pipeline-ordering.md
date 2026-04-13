---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 533
date: 2026-04-13
---
`postProcessSearchResults()` pipeline stages have ordering dependencies: any filter that reads `nzbName` must run after `enrichUsenetLanguages()` since that's the only function that populates the field. The `enrichUsenetLanguages` function also only processes results where `!r.language` — results with indexer-provided language never get nzbName populated. This scope limitation was the blocking finding in spec review and must be documented when adding nzbName-dependent filters.
