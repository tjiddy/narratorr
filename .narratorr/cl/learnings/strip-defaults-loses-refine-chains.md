---
scope: [frontend, core]
files: [src/shared/schemas/settings/strip-defaults.ts, src/shared/schemas/settings/library.ts]
issue: 215
date: 2026-03-30
---
Zod v4's `removeDefault()` on `ZodDefault<ZodRefine<...>>` loses the refine chains. `stripDefaults()` works for simple defaulted fields but not for fields like `folderFormatSchema` that chain `.default().refine().refine()`. Workaround: keep explicit form schemas for categories with refined defaults, using shared validation functions and message constants to avoid duplication.
