---
scope: [scope/frontend]
files: [src/client/pages/search/SearchResults.test.tsx, src/client/pages/search/SearchPage.test.tsx]
issue: 99
source: review
date: 2026-03-25
---
Same gap as F1: negating only the title string of a multi-part empty state (title + description + icon) does not prove the branch is blank. The old no-results state had three DOM elements: title ("No results for X"), description ("Try different keywords…"), and an icon. A test only negating the title passes if the description or icon are accidentally preserved. Fix: for any "remove empty state" AC, assert absence of ALL rendered parts — title text, description text, and SVG/icon nodes.
