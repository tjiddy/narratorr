---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.tsx, src/client/pages/settings/SearchSettingsSection.test.tsx]
issue: 341
date: 2026-03-12
---
When standalone form components use `DEFAULT_SETTINGS` for `useForm` defaultValues and then reset from query data via `useEffect`, tests must wait for the query data to arrive before asserting form state. DEFAULT_SETTINGS.search.enabled is `true` but mock data may set it `false` — if you assert immediately after render, you'll get the default, not the mock. Use `waitFor(() => expect(checkbox).not.toBeChecked())` to wait for the effect to fire.
