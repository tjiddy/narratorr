---
scope: [frontend]
files: [src/client/pages/search/SearchResults.test.tsx]
issue: 363
source: review
date: 2026-03-15
---
Tab ARIA tests must assert both halves of the contract: `aria-selected` state changes AND `tabpanel` `aria-labelledby` linkage changes. Testing only selection state without panel linkage allows a regression where the wrong panel stays mounted. Also must test all keyboard paths (ArrowRight AND ArrowLeft) and wraparound in both directions — not just one direction.
