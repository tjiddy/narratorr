---
scope: [core]
files: [src/core/indexers/fetch.ts, src/core/indexers/proxy.ts]
issue: 227
source: review
date: 2026-03-31
---
When integrating a shared utility (mapNetworkError) into multiple fetch layers, each integration point needs its own direct test — not just the unit test of the utility. The utility tests prove the mapping works; the integration tests prove the wiring is correct. Without integration tests, the mapper could be removed or bypassed without test failures.
