---
scope: [frontend]
files: [src/client/pages/settings/CrudSettingsPage.tsx, src/client/pages/settings/ImportListsSettings.tsx]
issue: 264
date: 2026-04-01
---
Changing a toggle button from "shows different text per state" to "always visible but disabled" has a blast radius in tests: any `getByRole('button', { name: /X/i })` selector that previously matched only one button (either the header or the form) may now match two (header is always "Add X", form submit is also "Add X"). The fix is systematic — replace all ambiguous submit button selectors with `getByText('X', { selector: 'button[type="submit"]' })`. Plan for this when the spec says "header stays visible but disabled."
