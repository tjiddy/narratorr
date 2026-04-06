---
scope: [frontend]
files: [src/client/pages/activity/DownloadCard.test.tsx]
issue: 357
date: 2026-04-06
---
Adding a React Router `<Link>` to any component requires migrating ALL existing tests from bare `render()` to `renderWithProviders()` (which includes `MemoryRouter`). The migration itself is mechanical (find-replace) and all existing assertions survive unchanged — but it must be done before running any tests, not after discovering the "useLocation outside Router" crash. Plan the harness migration as the first test step when adding any routing dependency.
