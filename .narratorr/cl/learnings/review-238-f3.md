---
scope: [frontend]
files: [src/client/pages/book/BookHero.test.tsx]
issue: 238
source: review
date: 2026-03-31
---
When adding new props to a child component (BookHero), always add child-layer contract tests — not just integration tests through the parent (BookDetails). The parent test proves the wiring works end-to-end, but the child test proves the component contract (callback forwarding, disabled state) independently. Both layers are needed.
