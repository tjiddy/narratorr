---
scope: [scope/frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 212
source: review
date: 2026-03-30
---
Reviewer caught that the save-failure test only asserted the error toast but not recovery behavior (form stays dirty, save button visible for retry). Root cause: test was written for the error notification but not the user's ability to recover. Prevention: for mutation error paths, always test two things: (1) error notification shown, (2) form/UI is in a state where the user can retry without re-entering data.
