---
scope: [frontend]
files: [src/client/pages/settings/FilteringSettingsSection.tsx]
issue: 386
date: 2026-04-07
---
React Hook Form's `watch()` from `useForm()` triggers a React Compiler lint warning (`react-hooks/incompatible-library`) because it returns a non-memoizable function. Use `useWatch({ control, name: 'field' })` instead — it provides the same reactive subscription without the compiler warning, and works correctly with zodResolver and form dirty tracking.
