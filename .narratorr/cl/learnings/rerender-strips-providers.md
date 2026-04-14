---
scope: [frontend]
files: [src/client/pages/settings/BlacklistSettings.test.tsx, src/client/pages/activity/EventHistorySection.test.tsx]
issue: 555
date: 2026-04-14
---
`renderWithProviders` returns RTL's `rerender` which does NOT re-wrap with providers (QueryClientProvider, MemoryRouter). Calling `rerender(<Component />)` remounts without context, causing either errors or full remount that invalidates effect-stability tests. For stable-deps regression tests, use `render()` directly with explicit provider wrapping on both initial render and rerender calls.
