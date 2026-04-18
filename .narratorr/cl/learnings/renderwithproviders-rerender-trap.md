---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.test.tsx, src/client/__tests__/helpers.tsx]
issue: 645
date: 2026-04-18
---
`renderWithProviders()` wraps the element in providers and passes the full tree to testing-library's `render()`. The returned `rerender()` function replaces the **entire** root tree, so calling `rerender(<Component />)` strips providers and causes "No QueryClient set" errors. Fix: create a local `withProviders(ui, queryClient)` helper that re-wraps the element, and pass a shared `QueryClient` to both `renderWithProviders({ queryClient })` and `withProviders()`. This wasn't obvious from the `renderWithProviders` signature since it returns a standard `RenderResult`.
