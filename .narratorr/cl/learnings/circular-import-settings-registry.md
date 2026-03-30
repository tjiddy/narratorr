---
scope: [core]
files: [src/shared/schemas/settings/registry.ts, src/shared/schemas/settings/strip-defaults.ts]
issue: 215
date: 2026-03-30
---
`registry.ts` imports all category schemas (quality.ts, general.ts, etc.) and exports `stripDefaults()`. If a category file imports `stripDefaults` from `registry.ts`, it creates a circular dependency. Solution: extract `stripDefaults()` into its own `strip-defaults.ts` module, then both `registry.ts` and category files can import from it without cycles.
