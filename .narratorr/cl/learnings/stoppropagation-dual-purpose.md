---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.tsx, src/client/pages/library/BookContextMenu.tsx]
issue: 549
date: 2026-04-14
---
stopPropagation in menu components often serves two distinct purposes: (1) preventing document-level outside-click listeners from firing, and (2) preventing event bubbling to parent navigation handlers. When extracting outside-click to a shared hook (which uses ref containment instead of stopPropagation), the navigation guard stopPropagation must be preserved separately. The spec review caught this ambiguity twice — always explicitly identify which purpose each stopPropagation serves before removing any.
