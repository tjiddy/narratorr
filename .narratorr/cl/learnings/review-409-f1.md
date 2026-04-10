---
scope: [backend, core]
files: [src/core/utils/collect-audio-files.ts, src/core/utils/audio-processor.ts, src/server/utils/import-helpers.ts]
issue: 409
source: review
date: 2026-04-10
---
When consolidating wrappers with "different sort semantics" into a shared helper, each consumer's original sort contract must be preserved exactly. Plain `.sort()` (lexicographic on full path), `localeCompare(b)` (locale on basename, no numeric), and `localeCompare(b, undefined, { numeric: true })` produce different orderings for names like `track10`/`track2`. The spec said "no behavior changes" but the shared helper hard-coded locale-numeric sort for all consumers. The plan step should have compared each wrapper's sort line-by-line against the replacement and verified semantic equivalence — not just structural similarity.
