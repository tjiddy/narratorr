---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettingsSection.test.tsx]
issue: 607
date: 2026-04-16
---
When migrating from inline forms to modal rendering, `container.querySelector()` in tests will fail because modal content portals to `document.body` via `createPortal`. Use `document.querySelector()` or Testing Library's `screen.*` queries (which search the full document) instead. Also, `screen.getByText(/pattern/)` may find duplicate matches when the modal and the list view both contain the same text (e.g., entity name in both the list row and the delete confirmation message).
