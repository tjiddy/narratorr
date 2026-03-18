---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/book/useBookActions.ts]
issue: 312
source: review
date: 2026-03-08
---
When extracting a hook from a component, side effects that reference component state (like `setEditModalOpen(false)`) can't move into the hook. The self-review subagent flagged this as a false positive because `BookMetadataModal` has its own `onClose` prop, but the actual close-on-save was triggered inside `handleSave`, not by the modal. Fix: accept an `onSuccess` callback parameter so the caller can inject state-dependent side effects.
