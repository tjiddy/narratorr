---
scope: [frontend, ui]
files: [src/client/index.css, src/client/components/AddBookPopover.tsx]
issue: 342
date: 2026-03-11
---
CSS `backdrop-filter` (including Tailwind's `backdrop-blur-xl`) creates a new stacking context on the element. Combined with animations that also create stacking contexts, z-index on child elements is trapped — it only competes within that context, never above sibling elements. The fix is portaling to document.body, not increasing z-index. This affects any dropdown/popover inside a glass-card styled container.
