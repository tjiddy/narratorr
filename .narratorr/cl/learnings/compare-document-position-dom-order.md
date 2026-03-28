---
scope: [frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 100
date: 2026-03-25
---
Testing DOM render order requires `compareDocumentPosition`: `element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING` is truthy when `other` comes after `element` in the document. Testing Library's role/text queries are order-agnostic, so layout-order specs must explicitly use this API — presence assertions alone don't catch reorder regressions.
