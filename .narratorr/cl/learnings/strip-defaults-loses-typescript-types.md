---
scope: [frontend, core]
files: [src/shared/schemas/settings/strip-defaults.ts, src/shared/schemas/settings/general.ts, src/shared/schemas/settings/discovery.ts]
issue: 215
date: 2026-03-30
---
`stripDefaults()` returns `z.object(newShape)` where `newShape: Record<string, z.ZodType>`, which loses TypeScript field type information. Calling `.pick()` on the result produces `z.ZodObject<Record<string, never>>` — useless for `z.infer`. For categories needing `.pick()` (general, discovery) or explicit typing, define form schemas explicitly with the same validators rather than deriving via `stripDefaults()`. The runtime behavior is correct but TypeScript can't track field names through the dynamic construction.
