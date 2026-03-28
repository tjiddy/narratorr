---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.test.tsx]
issue: 141
date: 2026-03-26
---
`ImportCard` renders a toggle as a `<button>` not a `<input type="checkbox">`, so `getByRole('checkbox')` fails. Use `getByRole('button', { name: /^deselect$/i })` (exact match) — the `/deselect/i` regex without anchors matches both the card toggle "Deselect" and the header "Deselect all", causing ambiguous-element errors.
