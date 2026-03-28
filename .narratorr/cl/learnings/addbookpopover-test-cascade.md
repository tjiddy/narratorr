---
scope: [frontend]
files: [apps/narratorr/src/client/components/AddBookPopover.tsx, apps/narratorr/src/client/pages/search/SearchBookCard.tsx, apps/narratorr/src/client/pages/author/AuthorPage.tsx]
issue: 267
date: 2026-03-06
---
Replacing a one-click button with a popover (AddBookPopover) cascades into every test that clicks that button. Tests that did `click(addButton) → expect(api.addBook)` now need two steps: `click(addButton) → click(addToLibrary)`. Six test files needed updating. When changing interaction patterns on shared components, budget for test cascade across all consumers.
