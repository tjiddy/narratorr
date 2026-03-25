---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/LibraryToolbar.tsx, src/client/pages/library/LibraryToolbar.test.tsx]
issue: 106
source: review
date: 2026-03-25
---
Reviewer caught that the primary UX goal of the issue — search-first layout with overflow-last ordering and a widened search input — was implemented but not protected by any regression test. The toolbar tests only proved that individual controls exist and respond to interaction; they never pinned the order or the min-width contract that motivated the issue in the first place.

Why missed: Tests were written control-by-control (each feature got its own describe block), and no test was written from the perspective of "does the overall composition match the spec?" The layout contract — child order and minimum width — was treated as a Tailwind styling detail rather than a verifiable behavior.

What would have prevented it: When an issue's primary deliverable is a composition or layout change (rather than new logic), the test plan should include a structural test asserting the DOM order and any CSS class contracts. Layout contracts are just as regressionable as logic contracts.
