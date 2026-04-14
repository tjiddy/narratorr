---
scope: [frontend]
files: [src/client/pages/settings/SettingsLayout.test.tsx, src/client/pages/SettingsPage.test.tsx]
issue: 550
date: 2026-04-14
---
When SettingsLayout renders its own `<Routes>` internally (instead of using `<Outlet>`), tests must wrap it in a parent `<Route path="/settings/*">` so the inner Routes can match relative paths. Without this parent context, paths like `indexers` never match against the full URL `/settings/indexers`. The `renderWithProviders` helper's bare `MemoryRouter` is insufficient — tests need an explicit route wrapper.
