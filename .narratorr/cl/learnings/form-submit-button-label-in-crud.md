---
scope: [frontend]
files: [src/client/components/settings/SettingsFormActions.tsx]
issue: 263
date: 2026-04-01
---
`SettingsFormActions` renders "Add {entityLabel}" in create mode and "Save Changes" in edit mode (line 55). Tests that submit the create form must use `getByRole('button', { name: /add client/i })` not `/save/i`. This caused test failures during #263 implementation.
