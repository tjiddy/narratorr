---
scope: [frontend, backend]
files: [src/shared/schemas/settings/processing.ts, src/client/pages/book/BookDetails.test.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 198
date: 2026-03-12
---
Adding new fields to a settings schema with defaults only breaks tests that use full hardcoded object overrides in `createMockSettings()`. Tests using `createMockSettings()` without overrides or with partial overrides inherit defaults automatically. The blast radius is predictable: grep for the old object literal pattern and use `replace_all` for the `enabled: true` variant, then handle `enabled: false` variants individually. Planning this as a distinct module in TDD prevents surprise failures during verify.
