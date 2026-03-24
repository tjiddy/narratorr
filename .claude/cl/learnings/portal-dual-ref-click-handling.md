---
scope: [frontend, ui]
files: [src/client/components/AddBookPopover.tsx]
issue: 342
date: 2026-03-11
---
When portaling a popover panel to document.body, the standard `ref.contains(e.target)` outside-click pattern breaks because the panel is no longer a DOM child of the trigger wrapper. Solution: maintain two separate refs (triggerRef + panelRef) and only close when the click target is outside both. This is a predictable consequence of portaling but easy to miss during implementation if you don't think through the DOM tree change.
