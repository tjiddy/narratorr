---
scope: [backend, services]
files: [src/server/services/quality-gate.service.ts]
issue: 422
date: 2026-03-17
---
When a service builds the same all-null object literal in 4+ places (e.g., QualityDecisionReason with null fields), extract a `const NULL_REASON` and spread overrides. This pattern saved ~30 lines in quality-gate.service.ts and made the 400-line ESLint target achievable.
