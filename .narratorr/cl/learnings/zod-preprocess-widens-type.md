---
scope: [frontend]
files: [src/client/components/ManualAddForm.tsx]
issue: 246
date: 2026-03-31
---
`z.preprocess()` widens the inferred input type to `unknown`, causing `zodResolver` type errors with `useForm`. Use `z.string().optional()` for the form field and convert to number in the mutation callback instead. `z.coerce.number()` also has issues (coerces empty string to 0).
