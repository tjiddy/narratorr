---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 82
date: 2026-03-25
---
In `@testing-library/user-event` v14, `keyboard('{author}')` fires a keydown/keyup for an unknown key named "author" — it does NOT type the literal text `{author}`. If you need to dirty a form field that contains `{token}` placeholders, use `user.type(input, '/extra')` appended to the existing value (preserving required tokens), not `user.tripleClick` + `user.keyboard('{token}')`. The latter clears the field and types nothing useful, leaving the field in an invalid state that silently prevents form submission.
