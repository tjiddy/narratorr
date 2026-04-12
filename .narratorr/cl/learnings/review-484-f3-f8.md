---
scope: [frontend]
files: [src/client/components/ConfirmModal.test.tsx, src/client/components/SearchReleasesModal.test.tsx, src/client/components/DirectoryBrowserModal.test.tsx, src/client/components/book/BookMetadataModal.test.tsx, src/client/components/manual-import/BookEditModal.test.tsx, src/client/components/ManualAddFormModal.test.tsx]
issue: 484
source: review
date: 2026-04-12
---
When `useEscapeKey(isOpen, ...)` is called before the early `if (!isOpen) return null`, the `isOpen` gate in the hook is the ONLY thing preventing document listeners from registering while closed. Testing "does not render when closed" and "Escape closes when open" does NOT prove the gate works — both pass even if `isOpen` is ignored. Every modal that calls `useEscapeKey` needs an explicit closed-state Escape assertion: render with `isOpen=false`, send `{Escape}`, assert callback was not called. The test plan should have listed this as a required test for every in-scope modal.
