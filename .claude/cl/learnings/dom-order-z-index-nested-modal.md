---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx]
issue: 161
date: 2026-03-28
---
With equal z-index values, DOM order determines paint order — elements appearing later in the DOM render on top. When SearchReleasesModal nests ConfirmModal, ConfirmModal must be rendered AFTER `<Modal>` in JSX (not before it) so it appears later in the DOM and paints on top. No z-index change is needed. The original code had ConfirmModal BEFORE the outer shell, which worked because ConfirmModal was rendered outside the outer div; after migration to `<Modal>`, swapping the order fixes stacking.
