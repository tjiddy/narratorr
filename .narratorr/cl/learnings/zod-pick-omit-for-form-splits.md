---
scope: [frontend]
files: [src/shared/schemas/settings/quality.ts]
issue: 265
date: 2026-03-31
---
When splitting a form into two independent sections (e.g., moving fields to a different page), use Zod `.pick()` and `.omit()` on the canonical form schema rather than creating new schemas from scratch. This preserves validation chains and avoids DRY violations. The derived schemas work correctly with `zodResolver` and `useForm` even when the full settings object is passed to `reset()` — react-hook-form ignores fields not in the schema.
