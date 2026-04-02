---
scope: [frontend]
files: [src/client/components/ManualAddForm.tsx, src/client/components/ManualAddFormModal.tsx]
issue: 296
date: 2026-04-02
---
When a child component owns a mutation but the parent needs to know its pending state (e.g., to disable Escape), use an `onPendingChange` callback prop with a `useEffect` watching `mutation.isPending`. This avoids lifting mutation state to the parent while keeping the child self-contained. The alternative (lifting the mutation) would break the child's encapsulation and require refactoring all existing callers.
