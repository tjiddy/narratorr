---
scope: [frontend]
files: [src/client/pages/book/BookDetails.test.tsx]
issue: 431
source: review
date: 2026-04-08
---
Visibility tests (show/hide) are necessary but not sufficient for interactive affordances. When a component wires an onClick callback, the click path must also be tested — a broken wiring passes visibility tests but the button does nothing. Always pair visibility assertions with at least one interaction assertion that verifies the API call.
