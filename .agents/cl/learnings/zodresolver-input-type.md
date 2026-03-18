---
scope: [frontend]
files: [apps/narratorr/src/shared/schemas/settings/registry.ts]
issue: 294
date: 2026-03-06
---
`zodResolver` infers form field types from a Zod schema's Input type parameter. Dynamically composed schemas (via `Object.fromEntries`) lose field-level type info, causing `Resolver<FieldValues>` instead of `Resolver<AppSettings>`. Fix by typing the schema as `z.ZodType<Output, Input>` with explicit Input matching Output (for forms where input = output). Use an intermediate variable + `as never` cast.
