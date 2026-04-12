---
scope: [backend, frontend]
files: [src/shared/schemas/settings/quality.ts, src/shared/schemas/settings/registry.ts, src/shared/schemas/settings/registry.test.ts]
issue: 503
date: 2026-04-12
---
Adding a field to quality settings has a narrow blast radius: only `registry.test.ts` hardcodes the full quality defaults object (2 tests). Most test files use `createMockSettings()` which deep-merges from `DEFAULT_SETTINGS` and auto-inherits new fields. The `qualityFormSchema` type assertion in `quality.ts` also needs manual update (Zod v4 debt item).
