---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx, src/client/pages/settings/NewBookDefaultsSection.test.tsx]
issue: 284
date: 2026-04-01
---
When extracting a component section into its own file (card split), the corresponding tests must also be moved — not duplicated. Replace old tests that rendered the parent with negative assertions (field NOT present in parent) and create new tests in the extracted component's test file. Avoids test duplication and keeps assertions co-located with the component they actually test.
