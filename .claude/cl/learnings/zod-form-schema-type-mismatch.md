---
scope: [frontend, backend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/shared/schemas/settings/discovery.ts]
issue: 406
date: 2026-03-17
---
Adding a new field to a shared settings schema (discoverySettingsSchema) caused a TypeScript error in the frontend form component. The form used `AppSettings['discovery']` as its type, but the form's zodResolver schema didn't include the new field. Fix: derive the form type from the form-specific schema (`z.infer<typeof discoveryFormSchema>`) instead of the full settings type. Internal/computed fields that aren't user-editable should never be in the form schema.
