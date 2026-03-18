---
scope: [frontend, ui]
files: [src/client/components/AddBookPopover.tsx]
issue: 342
date: 2026-03-11
---
When portaling a positioned element to document.body, the element loses its relationship to any scrollable ancestor. You must add explicit scroll (capture phase to catch any ancestor) and resize event listeners to recompute position via getBoundingClientRect. Without capture phase on scroll, events from scrollable containers (not just window scroll) are missed. Clean up listeners on close/unmount to avoid leaks.
