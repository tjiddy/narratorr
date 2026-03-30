---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 226
date: 2026-03-30
---
`screen.getByText(/Template must include/)` throws when multiple validation messages match (e.g., folder format AND file format both show the error). Use `getAllByText` with length assertion instead. This happens when form state changes trigger validation on multiple fields simultaneously.
