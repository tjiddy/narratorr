---
scope: [frontend]
files: [src/client/components/DeleteBookModal.tsx, src/client/pages/library/LibraryModals.tsx, src/client/pages/library/BulkActionToolbar.tsx]
issue: 238
date: 2026-03-31
---
When extracting a shared modal component from duplicated code (DRY fix), move the internal toggle state (like deleteFiles) INTO the new shared component and expose it via the onConfirm callback signature (`onConfirm(deleteFiles: boolean)`). This eliminates the need for parent components to manage the toggle state, reducing the parent's API surface. The old pattern had parents passing `deleteFiles`, `onDeleteFilesChange`, and `onDeleteConfirm` — the new pattern only needs `onConfirm` and `onCancel`.
