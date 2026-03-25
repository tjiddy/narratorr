---
scope: [scope/frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx, src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 93
source: review
date: 2026-03-25
---
When a component shows a watch-based real-time warning AND a separate resolver error with the same message text, an assertion like `expect(getAllByText(/.../).length).toBeGreaterThanOrEqual(1)` passes before any submit, proving nothing about the submit path.

The correct pattern: assert the PRE-submit count (expect 1 watch warning), then assert the POST-submit count increases to 2 (watch + resolver). The count increase proves the submit-time `errors.X` render path actually fired.

General rule: whenever testing form validation, ask "could this assertion pass without clicking submit?" If yes, add a pre-submit baseline count assertion.
