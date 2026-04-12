---
scope: [frontend]
files: [src/client/hooks/useSettingsForm.ts]
issue: 485
date: 2026-04-12
---
`zodResolver(schema)` with `z.ZodType<T>` causes a type error because zodResolver expects `_input` to be `FieldValues` (Record<string, any>), but `z.ZodType<T>` has `_input: unknown`. Fix: use `z.ZodType<T, T>` as the schema type in generic hook interfaces, and cast the resolver result as `Resolver<T>` if needed.
