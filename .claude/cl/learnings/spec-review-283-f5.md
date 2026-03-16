---
scope: [scope/frontend]
files: [src/client/App.tsx]
issue: 283
source: spec-review
date: 2026-03-10
---
Spec said "toasts auto-dismiss after 5 seconds" without clarifying whether this changes the global Toaster duration or only applies to SSE-triggered toasts. The app uses a global sonner Toaster and many existing flows depend on default behavior. Prevention: when specifying behavior for a shared component (toaster, modal, etc.), always state whether the change is scoped to the new feature or applies globally.
