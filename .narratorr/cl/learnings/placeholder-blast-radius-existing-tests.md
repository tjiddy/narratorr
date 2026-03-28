---
scope: [frontend]
files: [src/client/components/settings/IndexerCard.test.tsx, src/client/components/settings/DownloadClientCard.test.tsx, src/client/pages/settings/IndexersSettings.test.tsx, src/client/pages/settings/DownloadClientsSettings.test.tsx, src/client/pages/SettingsPage.test.tsx]
issue: 22
date: 2026-03-20
---
Changing a form field's placeholder from a hardcoded string to a dynamic expression cascades to every test that uses `getByPlaceholderText('OldValue')` — including page-level integration tests. In this case, changing `'AudioBookBay'` and `'qBittorrent'` would have broken tests if the new expression hadn't returned the same label for the default type. Always verify that registry label for the default type matches the old hardcoded string before assuming existing tests are unaffected.
