---
scope: [frontend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx]
issue: 367
date: 2026-03-16
---
Zod schemas with `.default()` produce an input type with optional fields, which is incompatible with `zodResolver<T>()` when T is the output type (required fields). Define a separate form schema without `.default()` for react-hook-form validation, or use the registry's `stripDefaults()` utility.
