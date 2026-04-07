---
scope: [backend, core]
files: [src/server/services/search-pipeline.test.ts]
issue: 394
source: review
date: 2026-04-07
---
When adding a new tier to canonicalCompare, test precedence against ALL higher tiers — not just the first two. The implementation tested matchScore and protocol preference but missed MB/hr and language. Each tier is an independent ordering rule that could be broken by a reorder. The test plan should have one "does NOT override" test per higher tier.
