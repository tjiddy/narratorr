---
scope: [scope/frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/search/SearchResults.tsx]
issue: 363
source: spec-review
date: 2026-03-14
---
Reviewer caught that the tab keyboard navigation AC was ambiguous — "navigate between tabs" could mean focus-only or automatic activation (focus + select + panel swap). The WAI-ARIA Tabs Pattern defines both models and they have materially different implementations and test expectations.

Root cause: The AC used vague language ("Left/Right arrow keys navigate between tabs") without specifying the activation model. This is a known ARIA design decision point that should be called out explicitly.

Prevention: For any ARIA widget pattern (tabs, menus, comboboxes, trees), the spec should explicitly name the activation model (automatic vs manual) since this is a fundamental design fork that affects both implementation and test assertions.
