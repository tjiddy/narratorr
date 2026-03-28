---
scope: [frontend]
files: [src/client/components/PathInput.tsx, src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 50
date: 2026-03-21
---
When a PathInput component bridges RHF's `register()` and programmatic value changes (e.g. directory browse selection), calling `registration.onChange({ target: { value: path } })` from outside a native input event does NOT reliably trigger `watch()` subscriptions — `isDirty` may update but the watched value stays stale. The correct pattern is to pass `onChange` as a separate prop and call `setValue(name, path, { shouldDirty: true, shouldValidate: true })` from the parent; `watch()` and `isDirty` both update reliably. The `registration` prop is only needed for spreading `name`, `ref`, `onChange`/`onBlur` onto the `<input>` element itself (for native typing events and RHF element tracking), not for programmatic value changes.
