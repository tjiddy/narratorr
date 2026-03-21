---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx, src/client/components/ConfirmModal.tsx]
issue: 18
date: 2026-03-21
---
ConfirmModal buttons have no `type` attribute, defaulting to `type="submit"` when inside a `<form>`. Always render ConfirmModal OUTSIDE the `<form>` element — as a sibling after the form's closing tag within the parent JSX. SettingsSection accepts multiple children, so `<SettingsSection><form>...</form><ConfirmModal .../></SettingsSection>` works naturally.
