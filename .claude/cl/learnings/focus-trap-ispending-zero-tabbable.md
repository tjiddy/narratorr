---
scope: [frontend]
files: [src/client/hooks/useFocusTrap.ts, src/client/components/WelcomeModal.tsx]
issue: 159
date: 2026-03-27
---
The real-world trigger for the "zero tabbable elements" fallback in a focus trap is a modal with a single button that becomes disabled (`isPending=true`). The `disabled` attribute removes an element from the tabbable selector. When writing tests for the zero-tabbable branch, use `isPending` to disable the only interactive element rather than constructing artificial DOM — this tests the actual production scenario.
