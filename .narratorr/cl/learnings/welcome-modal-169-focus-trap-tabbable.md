---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx, src/client/components/WelcomeModal.test.tsx]
issue: 169
date: 2026-03-28
---
The `useFocusTrap` hook includes `a[href]` in its tabbable selector. Converting 10 card `<div>` elements to `<a href>` elements changes tabbable count from 1 (Get Started button) to 11 (10 links + button), which breaks all existing focus-trap tests that assumed wrapping at 1. When converting static content to interactive links in a modal, update ALL focus-trap and keyboard-navigation tests — they will silently pass with wrong assertions if not updated before implementation.
