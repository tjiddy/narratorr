---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx, src/client/pages/library/LibraryPage.tsx]
issue: 133
source: review
date: 2026-03-26
---
When a page component adds a new query (e.g., getSettings) whose result drives conditional rendering, the page's test file must be updated to: (1) add the new api.* method to the mock, (2) add tests for each rendering branch the new query enables. The child component's unit tests (e.g., EmptyLibraryState) do not prove the parent page passes the right prop.
