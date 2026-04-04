---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 352
source: review
date: 2026-04-04
---
Reviewer caught that hook-level tests alone don't prove page-level restoration. renderHook tests verify the hook's state but don't prove the first getBooks API call uses URL-derived params. Adding page-level tests with `renderWithProviders(LibraryPage, { route: '/library?...' })` and asserting `api.getBooks` call arguments closes this gap. Prevention: when spec says "round-trip" or "restoration," always test the full consumer path (page rendering + API call), not just the hook in isolation.
