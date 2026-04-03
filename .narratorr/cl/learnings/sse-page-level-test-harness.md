---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx, src/client/components/SSEProvider.tsx]
issue: 312
date: 2026-04-03
---
Page-level SSE integration tests require mounting `SSEProvider` alongside the page component with a shared `QueryClient`. The standard `renderWithProviders` helper only provides `QueryClientProvider` + `MemoryRouter`, not `SSEProvider`. To test SSE-driven page updates: (1) create a `QueryClient`, (2) seed `['auth', 'config']` with `{ apiKey }` so `SSEProvider` connects, (3) compose `<SSEProvider />` and `<PageComponent />` as siblings inside the providers, (4) use a `MockEventSource` class with `simulateEvent()` to fire SSE events. Import `SSEProvider` at the top level (not via `require()` — ESM/Vite context doesn't support CJS require with path aliases).
