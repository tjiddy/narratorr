---
scope: [frontend]
files: [src/client/pages/settings/AppearanceSettingsSection.tsx, src/client/hooks/useTheme.ts]
issue: 108
date: 2026-03-25
---
Settings sections that control client-only state (localStorage, no server API) must NOT use react-hook-form dirty-state/save pattern. The toggle fires directly via `useTheme().toggleTheme()` on onChange — no form wrapper, no save button, no mutation. Other settings sections are all server-synced and use the form/dirty-state pattern; this section is the only exception. Future client-only settings controls should follow this same pattern.
