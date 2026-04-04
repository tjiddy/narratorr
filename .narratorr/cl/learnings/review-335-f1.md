---
scope: [backend, frontend]
files: [src/client/pages/manual-import/useManualImport.ts, src/client/pages/library-import/useLibraryImport.ts]
issue: 335
source: review
date: 2026-04-04
---
Reviewer caught that checking `state.metadata` presence alone is insufficient for confidence upgrade — Review rows open the BookEditModal with pre-populated metadata (from bestMatch), and saving without re-selecting still passes metadata back. The fix is a reference check (`state.metadata !== r.edited.metadata`) to distinguish explicit re-selection from passthrough. Missed because tests called `handleEdit` directly with fresh objects instead of simulating the real modal-save path where metadata is carried forward unchanged. Lesson: when testing state transitions triggered by modal saves, test both the "user changed something" and "user saved without changing" paths.
