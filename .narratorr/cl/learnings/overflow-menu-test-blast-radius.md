---
scope: [frontend]
files: [src/client/pages/book/BookHero.tsx, src/client/pages/book/BookDetails.test.tsx]
issue: 324
date: 2026-04-03
---
Moving inline buttons into a ToolbarDropdown overflow menu creates massive test blast radius in parent component tests. BookDetails.test.tsx had 40+ lines referencing `getByText('Edit')`, `getByText('Rename')`, etc. that all broke because menu items are now role="menuitem" inside a portal that only renders when open. Every test touching those buttons needed `openOverflowMenu(user)` inserted AND role queries changed from 'button' to 'menuitem'. Check parent integration tests before committing overflow menu changes.
