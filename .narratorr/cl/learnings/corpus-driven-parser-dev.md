---
scope: [core]
files: [packages/core/src/utils/parse.ts, packages/core/src/__tests__/fixtures/release-corpus.json]
issue: 118
date: 2026-02-23
---
Building a parser against assumed patterns vs. real data produces very different results. The initial parser based on research had bugs the corpus immediately exposed (inner quote handling, NZB track numbers, possessive patterns). Capturing 632 real release names from Prowlarr indexers before writing patterns saved multiple rewrite cycles. Always prefer real data over assumed formats.
