---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx, src/client/pages/library/LibraryToolbar.tsx]
issue: 106
date: 2026-03-25
---
LibraryPage.test.tsx has deep integration tests that interact with UI controls directly (status pills, sort select, action buttons). When the toolbar is refactored to replace these with dropdown/menu components, all such tests break — 25 failures in one verify run. The blast radius of a toolbar UI refactor includes the page-level integration tests, not just component-level tests. When planning a toolbar redesign, budget extra time to update LibraryPage.test.tsx alongside the new component tests.
