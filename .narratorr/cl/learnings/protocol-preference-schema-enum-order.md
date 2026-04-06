---
scope: [frontend]
files: [src/shared/schemas/settings/quality.ts, src/client/pages/settings/SearchSettingsSection.tsx]
issue: 389
date: 2026-04-06
---
`protocolPreferenceSchema.options` returns enum values in declaration order: `['usenet', 'torrent', 'none']`, not alphabetical. Test assertions on dropdown option order must match the schema's declaration order. The "No Preference" option (value `'none'`) appears last, not first. Read `.options` from the schema before writing order-dependent assertions.
