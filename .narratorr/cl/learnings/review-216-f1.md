---
scope: [frontend]
files: [src/client/pages/settings/MetadataSettingsForm.test.tsx, src/client/pages/settings/GeneralSettingsForm.test.tsx, src/client/pages/settings/QualitySettingsSection.test.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx, src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 216
source: review
date: 2026-03-30
---
When extracting a shared UI component and converting consumers, existing tests that only assert values and save flows will still pass if the conversion silently reverts. Each converted consumer needs at minimum one regression assertion proving the shared component contract is active (e.g., `appearance-none` class + chevron SVG present). Without these, the extraction is unverified at the integration layer.
