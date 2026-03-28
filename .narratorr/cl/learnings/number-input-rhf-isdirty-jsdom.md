---
scope: [frontend]
files: [src/client/pages/settings/BackupScheduleForm.test.tsx]
issue: 362
date: 2026-03-13
---
Number inputs with RHF `register('field', { valueAsNumber: true })` cannot be made dirty via `userEvent` in jsdom. `user.clear()` throws "not editable" on number inputs, and `user.tripleClick()` + `user.type()` doesn't trigger RHF's dirty tracking. `fireEvent.change` sets the DOM value but doesn't propagate through RHF's state to flip `isDirty`. The only reliable way to test form submission on these forms is `fireEvent.submit(form)`. This is the same constraint that justifies the `NetworkSettingsSection.test.tsx:278` direct-submit pattern.
