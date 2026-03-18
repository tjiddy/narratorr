---
scope: [frontend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/client/pages/settings/GeneralSettings.test.tsx]
issue: 367
date: 2026-03-16
---
All settings sections in GeneralSettings use `{isDirty && <SaveButton />}` to conditionally render save buttons. The GeneralSettings test asserts `queryAllByRole('button', { name: /save/i }).toHaveLength(0)` when clean. New settings sections MUST follow this pattern or the integration test breaks.
