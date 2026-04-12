---
scope: [backend, core]
files: [src/core/metadata/audible.ts, src/core/metadata/audible.test.ts]
issue: 497
source: review
date: 2026-04-12
---
When fixing a data precision bug at the adapter layer, the fix must be pinned with an adapter-level test — not just a downstream consumer test. The same-year sort test in helpers.test.ts proved the sort logic works but couldn't catch a regression in the Audible mapper. Always test the contract at the boundary where the fix lives.
