---
scope: [scope/frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 212
source: review
date: 2026-03-30
---
Reviewer caught that file format validation had no test coverage — only folder format validation was tested. Root cause: the component has separate validation for both fields but only one was exercised in tests. Prevention: when a component has N parallel validation branches (folder format + file format), test each branch independently — don't assume coverage of one implies coverage of the other.
