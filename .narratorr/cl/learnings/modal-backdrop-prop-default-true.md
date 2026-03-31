---
scope: [frontend]
files: [src/client/components/Modal.tsx]
issue: 234
date: 2026-03-31
---
When adding a behavioral prop to a shared component (like `closeOnBackdropClick` on Modal), always default to the existing behavior (`true`) so existing consumers don't need changes. This makes the change purely additive — only consumers that want the new behavior opt in. The key implementation detail: React tolerates `onClick={undefined}` safely, so the conditional `onClick={closeOnBackdropClick ? onClose : undefined}` works without a wrapper function.
