---
scope: [frontend]
files: [src/client/components/DirectoryBrowserModal.tsx, src/client/components/manual-import/BookEditModal.tsx, src/client/index.css]
issue: 80
date: 2026-03-24
---
Making the backdrop div opaque (bg-black/80+) is sufficient to eliminate modal bleed-through even when the modal panel uses `glass-card` (bg-card/60–80%). The panel's transparent parts show the dark backdrop, not page content. You don't need to change the panel class — only the backdrop needs to be sufficiently dark.
