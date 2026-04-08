---
scope: [frontend]
files: [src/client/components/Badge.tsx, src/client/components/manual-import/ImportCard.tsx]
issue: 415
source: review
date: 2026-04-08
---
When adding a tooltip (`title` attribute) to a non-interactive element like `<span>`, the element must also be keyboard-focusable (`tabIndex={0}`) to satisfy accessibility. The spec said "hover or focus" but the implementation only handled hover. Self-review and test coverage both missed this because tests only asserted the `title` attribute existed, not that a user could actually reach it via keyboard. Fix: when adding `title` to non-interactive elements, always add `tabIndex={0}` and a focus interaction test.
