---
scope: [frontend]
files: [src/client/pages/settings/registry.ts, src/client/pages/settings/SettingsLayout.tsx, src/client/App.tsx]
issue: 389
date: 2026-04-06
---
Adding a new settings page requires only one wiring change: insert a `SettingsPageEntry` into `settingsPageRegistry` in `registry.ts`. Routes (App.tsx) and sidebar links (SettingsLayout.tsx) are both generated from this array via `.map()`. The spec initially pointed at App.tsx and Layout.tsx for wiring — this caused two rounds of spec review before correcting to registry.ts. Always check how routes are generated before assuming file-level wiring.
