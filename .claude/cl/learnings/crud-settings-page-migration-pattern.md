---
scope: [scope/frontend]
files: [src/client/pages/settings/IndexersSettings.tsx, src/client/pages/settings/NotificationsSettings.tsx]
issue: 437
date: 2026-03-18
---
Migrating from inline useCrudSettings to CrudSettingsPage is a direct 1:1 mapping — the card component props map exactly to the renderCard handler fields. The only gotcha is extra UI elements (like Prowlarr import button) which go via the headerExtra prop. All existing tests pass without modification because they test user interactions, not component structure — this validates the "test consequences not implementation" principle.
