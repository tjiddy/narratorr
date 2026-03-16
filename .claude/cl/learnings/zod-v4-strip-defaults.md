---
scope: [backend, frontend, core]
files: [apps/narratorr/src/shared/schemas/settings/registry.ts]
issue: 294
date: 2026-03-06
---
Zod v4 `schema.shape` entries are internal `$ZodType`, not public `ZodType`. `removeDefault()` also returns `$ZodType`. When building new shapes dynamically (e.g., stripping defaults), cast the result `as never` to bridge the internal/public type gap. This applies to any dynamic schema manipulation in Zod v4.
