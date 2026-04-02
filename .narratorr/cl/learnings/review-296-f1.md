---
scope: [frontend]
files: [src/client/components/ManualAddFormModal.tsx]
issue: 296
source: review
date: 2026-04-02
---
When the spec says "Escape and close button are disabled while pending," the close button is a concrete UI element that must exist. Wrapping a form in Modal without a close control diverges from the established form-modal pattern (SearchReleasesModal, BookEditModal, NamingTokenModal all have explicit XIcon close buttons). The explore phase identified the pattern but implementation skipped the close button. Check: does the modal have all the chrome elements (header, close button) that sibling modals have?
