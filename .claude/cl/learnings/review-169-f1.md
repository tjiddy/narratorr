---
scope: [scope/frontend]
files: [src/client/components/WelcomeModal.tsx, src/client/components/WelcomeModal.test.tsx]
issue: 169
source: review
date: 2026-03-28
---
When converting static `<div>` cards to `<a href>` links, the tabbable element set changes. `useFocusTrap` will now focus the first card link instead of the dialog container when `isPending=true`. Any time a new tabbable element is introduced inside a modal that has an isPending guard, the isPending focus behavior must be explicitly re-tested: does the expected element still receive focus, or has a newly tabbable element stolen it? The fix pattern is a second `useEffect` on `[isOpen, isPending]` that calls `modalRef.current.focus()`, firing *after* `useFocusTrap`'s effect and overriding it. The test should assert `document.activeElement === screen.getByRole('dialog')`, not any specific child element.
