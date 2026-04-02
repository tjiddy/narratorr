---
scope: [frontend]
files: [src/client/components/ManualAddFormModal.tsx]
issue: 296
date: 2026-04-02
---
When wrapping a form component in a modal, returning `null` when `!isOpen` (unmount/remount) is the cleanest way to reset form state between close/reopen cycles. No explicit `reset()` call needed on close — the form's `defaultValues` re-initialize on mount. This is simpler than adding a close handler that calls `form.reset()` and avoids stale state bugs.
