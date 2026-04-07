---
scope: [backend, core]
files: [src/server/services/search-pipeline.test.ts]
issue: 394
source: review
date: 2026-04-07
---
Language tier precedence tests require setting the `languages` parameter in filterAndRankResults AND giving results different `language` fields — one matching and one not. Without the languages parameter populated, the language tier is skipped entirely and the test would be vacuous. Same applies to MB/hr (needs `bookDuration` set and different `size` values).
