---
scope: [frontend]
files: [src/client/pages/settings/CrudSettingsPage.tsx]
issue: 353
date: 2026-04-05
---
Adding an optional `modal` prop to a shared container like `CrudSettingsPage` is safer than refactoring the container wholesale. Existing consumers (NotificationsSettings) keep inline behavior without changes. The key pattern: inline rendering gates on `!modal && showForm`, modal rendering gates on `isModalOpen`, and cards always render as 'view' in modal mode (edit happens in the modal). Form state resets via unmount when the modal closes (learning from `modal-form-reset-via-unmount.md`).