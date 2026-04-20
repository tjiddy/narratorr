---
scope: [frontend, testing]
files: [src/client/pages/book/BookLocationSection.tsx, src/client/pages/book/BookLocationSection.test.tsx]
issue: 657
source: review
date: 2026-04-20
---
Reviewer caught an AC-backed contract (`<code title={path}>` hover fallback) that was referenced in the AC bullet but only class-list tested — the `title` attribute could be deleted without turning the suite red. Test-plan gap: when an AC enumerates multiple attributes on the same element (`font-mono`, `break-all`, `select-all`, `title={path}`), one test per attribute category is safer than one combined "renders with expected styling" test. Rule: grep the spec's AC bullet for every named attribute/prop and ensure each has its own explicit assertion — `.getAttribute('title')` for HTML attrs, `.className` for classes, `.textContent` for text. Class list coverage does not imply attribute coverage.
