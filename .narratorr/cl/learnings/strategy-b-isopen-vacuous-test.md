---
scope: [frontend]
files: [src/client/components/book/BookMetadataModal.tsx, src/client/components/manual-import/BookEditModal.tsx]
issue: 484
date: 2026-04-12
---
When testing Strategy B → A migration (`isOpen` prop added), passing `isOpen=false` to a component that doesn't destructure `isOpen` is silently ignored — the component renders normally and the test is vacuous. Modal.tsx uses createPortal, so `container.querySelector` and `toBeEmptyDOMElement()` also give false negatives. Use `screen.queryByRole('dialog')` or `screen.queryByText(...)` to assert absence on portal-rendered content.
