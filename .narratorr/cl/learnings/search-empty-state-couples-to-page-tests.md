---
scope: [frontend]
files: [src/client/pages/search/SearchPage.tsx, src/client/pages/search/SearchResults.tsx, src/client/pages/search/SearchPage.test.tsx]
issue: 69
date: 2026-03-24
---
When a SearchPage test asserts "no 'discover' language in headings" using `queryByText(/discover/i)`, it catches the pre-search empty state description rendered by SearchResults (a child component) — not just the hero headline. This surfaced an implicit coupling: the "hero removal" module test was blocked until the empty state copy (a separate module) was also fixed. Plan modules that share copy/language concerns in the same commit, or scope cross-component text assertions to headings only using `queryAllByRole('heading')`.
