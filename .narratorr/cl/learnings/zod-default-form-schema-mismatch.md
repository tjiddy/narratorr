---
scope: [backend, frontend]
files: [src/shared/schemas/settings/library.ts]
issue: 210
date: 2026-03-29
---
When a Zod schema uses `.default()` (e.g., `z.enum(values).default('space')`), the input type becomes optional but the output type is required. This creates a TypeScript mismatch when `zodResolver(formSchema)` is used with React Hook Form — the form's type expects the output shape (required), but the resolver's generic uses the input shape (optional). Fix: use the bare `z.enum(values)` without `.default()` in the form schema, since the form always has explicit values via `defaultValues`.
