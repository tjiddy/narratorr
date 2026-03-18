---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.test.tsx, src/client/pages/settings/ImportSettingsSection.test.tsx]
issue: 358
date: 2026-03-13
---
Settings section tests that reference a "Save" button will fail if the component conditionally renders it only when `isDirty` (React Hook Form). Tests from an older branch version may assume the button is always present. When resolving merge conflicts in settings test files, verify the component's save button rendering logic — tests may need to dirty the form first by changing a value before asserting the save flow.
