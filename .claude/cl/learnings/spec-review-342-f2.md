---
scope: [scope/frontend, scope/ui]
files: [src/client/components/AddBookPopover.tsx]
issue: 342
source: spec-review
date: 2026-03-11
---
Spec proposed portaling the popover to `document.body` without analyzing how the current outside-click handler (`popoverRef.current.contains(e.target)`) depends on the panel being a DOM child of the wrapper ref. Portal moves break parent-child containment — any spec proposing a portal must explicitly address click delegation between trigger and panel refs.
