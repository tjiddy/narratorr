---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 564
source: review
date: 2026-04-15
---
When refactoring a page's loading branch to use a shared component (PageLoading), existing page tests that only assert spinner presence don't prove header slot wiring. Must also assert the specific header content (e.g., Import Files link with correct href) survives the refactor. The gap was assuming existing tests covered the new wiring when they only tested one dimension.
