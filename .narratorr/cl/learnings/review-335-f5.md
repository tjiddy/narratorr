---
scope: [frontend]
files: [src/client/components/manual-import/BookEditModal.tsx, src/client/pages/manual-import/useManualImport.ts, src/client/pages/library-import/useLibraryImport.ts]
issue: 335
source: review
date: 2026-04-04
---
When using reference identity to detect state changes (e.g., `state.metadata !== r.edited.metadata`), check whether the UI component that produces the state preserves references from initial props. BookEditModal seeds `initialResults` from `initial.metadata` and `applyMetadata` set `selectedMetadata` to those seeded objects — same reference as the initial. Fix: spread the object in `applyMetadata` so any explicit user interaction creates a new reference. The general pattern: when a modal/form produces state that downstream consumers compare by identity, ensure user interactions break reference identity even when the user selects the same logical value.
