---
scope: [backend, frontend]
files: [src/shared/schemas/settings/registry.test.ts, src/shared/schemas/settings/registry.ts]
issue: 198
source: review
date: 2026-03-12
---
When adding conditional form validation (field required only when another field is non-empty), both branches need test coverage: the error branch (non-empty trigger + missing value) AND the success branch (empty trigger + missing value passes). Round 1 only tested the error path; reviewer caught the missing success path test in round 2.
