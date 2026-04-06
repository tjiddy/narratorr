---
scope: [frontend]
files: [src/client/pages/activity/DownloadCard.test.tsx]
issue: 357
source: review
date: 2026-04-06
---
When testing a React Router `<Link>` click interaction, asserting `href` alone is insufficient — it's a static attribute that exists before the click. The test must prove route state changed by rendering with a `Routes` tree and asserting the destination route content appears after the click. `renderWithProviders` wraps with a flat `MemoryRouter` (no routes), so navigation tests need a custom render with `<Routes>` + `<Route>` elements. The spec review's F1 suggestion flagged this gap but the implementation didn't follow through strongly enough.
