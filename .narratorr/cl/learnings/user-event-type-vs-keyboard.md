---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 202
date: 2026-03-29
---
In @testing-library/user-event v14, both `keyboard()` and `type()` interpret `{text}` as special key syntax. To type literal brace characters into form fields, use `user.clear()` + `user.type(el, 'plain-text')` — avoid any string containing `{...}` in keyboard/type calls. For tests that just need to dirty a field, the typed value doesn't need to match the real format.
