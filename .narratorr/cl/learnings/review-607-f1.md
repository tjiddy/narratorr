---
scope: [frontend]
files: [src/client/pages/settings/CrudSettingsPage.tsx, src/client/components/Modal.tsx]
issue: 607
source: review
date: 2026-04-16
---
CrudSettingsPage modal didn't enable `scrollable` on the Modal component. When forms have provider-specific fields (e.g., Import Lists with ABS/NYT/Hardcover settings), the modal can overflow the viewport. The Modal component already has a `scrollable` prop that adds `max-h-[85vh]` — it just wasn't wired. Should check viewport-overflow behavior when moving forms into modals during implementation.
