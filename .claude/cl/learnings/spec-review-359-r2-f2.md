---
scope: [scope/backend, scope/frontend]
files: [src/client/pages/settings/GeneralSettings.test.tsx, src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 359
source: spec-review
date: 2026-03-14
---
Round 2 review caught that M-6's "complete file set" missed 2 test files using `vi.mock('../../../core/utils/index.js', ...)`. Root cause: the grep for deep core imports only searched for `from` import statements, not `vi.mock()` calls which also encode module paths. Would have been prevented by grepping for any occurrence of `core/utils` in client files (not just import statements) when claiming completeness.
