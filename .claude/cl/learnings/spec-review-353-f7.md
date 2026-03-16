---
scope: [infra]
files: [scripts/verify.ts]
issue: 353
source: spec-review
date: 2026-03-14
---
Spec pointed implementers to the coverage gate's `diff --name-only` pattern for lint diffing, but that pattern only works at file granularity. It cannot distinguish new lint violations from pre-existing ones within the same changed file. For lint diffing, a violation-level comparison (e.g., ESLint `--format json` tuple diff) is needed to uphold the "only new violations" guarantee.
