---
scope: [backend]
files: [src/shared/schemas/settings/registry.test.ts, src/shared/schemas/settings/processing.ts]
issue: 198
source: review
date: 2026-03-12
---
Reviewer caught that schema constraints (`.min(1)`, `.int()`) had no direct boundary tests — only a default snapshot. If `.min(1)` were removed, tests would still pass. When adding Zod schema constraints, always add boundary tests: default value, reject-at-boundary (0 for min(1)), reject-type-violation (1.5 for int()).
