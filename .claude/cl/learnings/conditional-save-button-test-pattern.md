---
scope: [frontend]
files: [src/client/pages/settings/GeneralSettingsForm.test.tsx, src/client/pages/settings/MetadataSettingsForm.test.tsx]
issue: 341
date: 2026-03-12
---
When save buttons are conditionally rendered (`{isDirty && <button>}`), tests that previously used `fireEvent.submit` to "bypass isDirty gating" break — the button doesn't exist to find `.closest('form')`. Fix by making the form dirty first (user interaction), then finding the button. Tests asserting "button is disabled when clean" become "button is not in document when clean" using `queryByRole` + `.not.toBeInTheDocument()`.
