---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.url-restore.test.tsx]
issue: 352
source: review
date: 2026-04-04
---
Route-level restoration tests require a separate test file from LibraryPage.test.tsx because the main file globally mocks `useNavigate`, preventing real router navigation. For back-navigation tests: (1) mount both routes in a real route tree, (2) add a stub page component with `useNavigate(-1)` for the back action, (3) note that `window.history.back()` doesn't work in MemoryRouter — must use router's own navigation, (4) TanStack Query may serve cached data instead of re-fetching after back-nav, so assert on rendered UI state rather than API call count.
