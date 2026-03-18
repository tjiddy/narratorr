---
scope: [scope/frontend]
files: [src/client/pages/settings/ImportSettingsSection.test.tsx, src/client/pages/settings/QualitySettingsSection.test.tsx, src/client/pages/settings/SearchSettingsSection.test.tsx]
issue: 339
date: 2026-03-11
---
When background agents convert `userEvent.clear()+type()` to `fireEvent.change()` and remove the `const user = userEvent.setup()` line, the pre-commit linter hook may revert these changes if the file is modified again by a different edit. Always verify agent edits survive the commit pipeline — check `git diff` after committing, not just after editing.
