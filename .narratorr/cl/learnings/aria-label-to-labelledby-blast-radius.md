---
scope: [frontend]
files: [src/client/components/book/BookMetadataModal.tsx, src/client/components/manual-import/BookEditModal.tsx]
issue: 484
date: 2026-04-12
---
Replacing `aria-label` with `aria-labelledby` on a dialog changes the accessible name used by `getByRole('dialog', { name: ... })` in Testing Library. Parent page tests that query by the old `aria-label` text will break — grep for the old aria-label value across `**/*.test.ts*` before committing the change. The new accessible name comes from the heading element's text content, not the aria-label string.
