---
scope: [frontend]
files: [src/client/components/ToolbarDropdown.tsx]
issue: 353
source: review
date: 2026-04-05
---
When elevating a dropdown above a modal overlay, use `z-50` (same as modal) instead of inventing `z-[60]`. Since the dropdown portal is added to `document.body` after the modal portal (later DOM order), same z-index renders it on top. This respects the documented z-index scale (CSS-1) without introducing arbitrary values outside the scale.