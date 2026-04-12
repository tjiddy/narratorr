---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/hooks/useEscapeKey.ts]
issue: 484
date: 2026-04-12
---
Nested modal Escape isolation doesn't require hook changes. Gate the outer modal's `useEscapeKey` `isOpen` argument on the inner modal's state: `useEscapeKey(isOpen && pendingReplace === null, onClose, modalRef)`. When the inner modal is open, the outer's Escape listener is deregistered. The inner modal's own `useEscapeKey` handles Escape independently. This is simpler and more robust than event interception approaches (`preventDefault`, `stopImmediatePropagation`).
