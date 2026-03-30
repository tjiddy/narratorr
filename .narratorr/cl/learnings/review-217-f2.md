---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 217
source: review
date: 2026-03-30
---
When a function has two code paths (insert at cursor vs replace selection), both must have dedicated tests. The `selectionStart`/`selectionEnd` replacement branch in `insertTokenAtCursor` was untested. In jsdom, use `input.setSelectionRange(start, end)` before triggering the insertion to exercise the selection-replacement path.
