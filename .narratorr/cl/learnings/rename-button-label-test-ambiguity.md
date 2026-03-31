---
scope: [frontend]
files: [src/client/pages/library/BulkActionToolbar.test.tsx]
issue: 254
date: 2026-03-31
---
When renaming a button label to match a sibling button in the same DOM tree (e.g., toolbar trigger and modal confirm both saying "Remove"), `getByRole('button', { name: ... })` becomes ambiguous after the modal opens. Use `within(screen.getByRole('dialog'))` to scope the confirm button query. This is easy to miss because the tests pass individually before the rename — the ambiguity only surfaces when both buttons share the same accessible name.
