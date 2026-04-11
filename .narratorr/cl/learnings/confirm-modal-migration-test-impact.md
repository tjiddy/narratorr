---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.tsx, src/client/pages/settings/SecuritySettings.test.tsx]
issue: 488
date: 2026-04-11
---
Migrating inline confirm panels to ConfirmModal changes the DOM structure: the confirmation text is now inside a `role="dialog"` element. Existing tests that assert on confirmation text content (like `/are you sure you want to disable authentication/i`) will fail because the ConfirmModal uses different title/message text. Check all tests referencing the old inline panel text before committing. The API key section also changes behavior: the "Regenerate API Key" button is now always visible (not conditionally replaced by the confirm panel), since ConfirmModal overlays instead of replacing.
