---
scope: [frontend]
files: [src/client/pages/settings/SettingsLayout.tsx, src/client/pages/settings/registry.ts, src/client/App.tsx]
issue: 550
date: 2026-04-14
---
The settings page registry (`settingsPageRegistry`) was imported in both `App.tsx` (for route generation) and `SettingsLayout.tsx` (for nav links). This coupling meant lazy-loading SettingsLayout alone still eagerly pulled all 10 settings sub-pages. Fix: use `path="settings/*"` in App.tsx and render `<Routes>` inside SettingsLayout, so the registry + all sub-page imports live entirely within the settings chunk.
