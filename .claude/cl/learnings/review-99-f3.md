---
scope: [scope/frontend]
files: [src/client/components/layout/Layout.test.tsx]
issue: 99
source: review
date: 2026-03-25
---
`renderWithProviders(<Layout />, { route })` sets the MemoryRouter's initial location but does NOT define a Routes/Route tree. Because Layout uses React Router's `<Outlet>`, no child route content renders — the Outlet is empty. A test that only checks navigation presence on a given route does NOT verify that route content renders inside `<main>`. Fix: for layout shell regression tests, use `render()` directly with a full `<Routes><Route path="/" element={<Layout />}><Route path="X" element={<div data-testid="X-content" />} /></Route></Routes>` tree, then assert `main.querySelector('[data-testid="X-content"]') !== null`.
