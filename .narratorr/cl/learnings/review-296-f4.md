---
scope: [frontend]
files: [src/client/components/ManualAddFormModal.tsx]
issue: 296
source: review
date: 2026-04-02
---
When creating a new modal component that uses `useEscapeKey(isOpen, handler, modalRef)`, the ref target must have `role="dialog"`, `aria-modal="true"`, and `tabIndex={-1}` for the focus handoff to work (`useEscapeKey` calls `focusRef.current.focus()` on open). All sibling form modals (SearchReleasesModal, BookEditModal) follow this pattern. Without `tabIndex={-1}`, `focus()` is a no-op on a non-focusable div, and the dialog semantics are lost. Check: when adding `useEscapeKey` to a new modal, verify the ref target is focusable.
