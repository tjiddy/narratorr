---
scope: [frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx]
issue: 219
date: 2026-03-30
---
`z.preprocess()` creates `ZodEffects` with `_input: unknown`, which makes the entire object schema's input type diverge from its output type. `zodResolver` requires aligned input/output types (`Zod3Type<Output, Input>` where both are `FieldValues`). The fix is to move NaN→undefined coercion from the Zod schema to react-hook-form's `register()` via `setValueAs`, keeping the schema field as plain `z.number().int().min(1).optional()` with no type divergence. `.transform()` also creates `ZodEffects` and causes similar (though different) divergence — it makes the field optional in `_input` but required in `_output`.
