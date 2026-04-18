---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.test.tsx]
issue: 645
source: review
date: 2026-04-18
---
Negative-path visibility tests (asserting an element is absent) are vacuous unless they first prove the surrounding container IS present. Testing `queryByText('Retry Import').not.toBeInTheDocument()` passes trivially if the entire context menu disappears. Always add a positive anchor assertion on a stable sibling element (e.g., "Search Releases" is visible) before the negative assertion. This applies to any conditional-render test where the parent container could also be absent.
