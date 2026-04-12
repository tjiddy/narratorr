---
scope: [frontend]
files: [src/client/pages/discover/SuggestionCard.test.tsx]
issue: 501
date: 2026-04-12
---
When a component gains a dependency on `useQuery` (e.g., by embedding `AddBookPopover` which internally calls `useQuery`), all existing tests using bare `render()` must migrate to `renderWithProviders()`. Bulk find-and-replace of `render(<Component` misses multi-line `render(\n  <Component` patterns — run `grep render\(` after replacement to catch stragglers. The error is "No QueryClient set" which is clear, but the regex gap can leave 5+ tests broken.
