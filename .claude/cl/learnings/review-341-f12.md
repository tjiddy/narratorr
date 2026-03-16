---
scope: [scope/frontend]
files: [src/client/pages/settings/NetworkSettingsSection.test.tsx]
issue: 341
source: review
date: 2026-03-12
---
Sentinel round-trip test typed the sentinel into an empty field instead of starting from a server-hydrated value. This didn't test the actual user flow where the server returns a masked proxy URL. Gap: test didn't match the real scenario (server seeds the value, user saves without changing it).
