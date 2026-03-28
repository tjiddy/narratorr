---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 50
date: 2026-03-21
---
`toHaveValue(expect.stringContaining('...'))` from `@testing-library/jest-dom` does NOT work as an asymmetric matcher in vitest — the assertion fails even when the received string does contain the expected substring. Use exact string assertions (`toHaveValue('/exact/path')`) or access the DOM value directly (`(input as HTMLInputElement).value`) and use `.toContain()`. The issue caused a 1300ms waitFor timeout that appeared to be a value-update bug but was actually an assertion bug — the value was correctly `/audiobooks/new-library` all along.
