---
scope: [frontend]
files: [src/client/pages/settings/DownloadClientsSettings.test.tsx, src/client/pages/settings/IndexersSettings.test.tsx, src/client/pages/settings/NotificationsSettings.test.tsx, src/client/pages/settings/ImportListsSettingsSection.test.tsx]
issue: 264
date: 2026-04-01
---
When a header button and a form submit button share the same text (e.g., "Add Client"), `getByRole('button', { name: /Add Client/i })` matches both and throws a "multiple elements found" error. Use `getByText('Add Client', { selector: 'button[type="submit"]' })` to target the submit button specifically. This pattern already existed in ImportListsSettingsSection.test.tsx:507 but wasn't used consistently — now it's the standard approach across all CRUD settings page tests.
