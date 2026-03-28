---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx, src/client/hooks/useEscapeKey.ts]
issue: 157
date: 2026-03-27
---
Intentional "no escape" modals (onboarding, forced-setup) pass `false` (not the real `isOpen`) as the first arg to `useEscapeKey`. This prevents the escape key from closing the modal. Always test this explicitly: render with `isOpen=true`, dispatch Escape, verify `onDismiss` was not called. Without the test, the hook's first-arg behavior is invisible and easy to accidentally break.
