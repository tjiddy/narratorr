---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettings.tsx]
issue: 423
date: 2026-03-17
---
Testing Library's `getByLabelText` resolves BOTH implicit (wrapping `<label>`) and explicit (`htmlFor`/`id`) label associations. When testing that explicit label pairing was added, use DOM attribute assertions (`toHaveAttribute('id', 'x')`, `querySelector('label[for="x"]')`) rather than `getByLabelText` which would pass before the change too.
