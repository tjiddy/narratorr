---
scope: [frontend]
files: [src/client/pages/library/useLibraryFilters.ts, src/client/pages/library/useLibraryFilters.test.tsx]
issue: 352
date: 2026-04-04
---
Adding `useSearchParams` to a hook makes ALL existing `renderHook()` calls fail because the hook now requires Router context. When converting a hook to use URL params, plan to update every existing test's wrapper to include `MemoryRouter` — this is a cross-cutting test infrastructure change, not just "add new tests."
