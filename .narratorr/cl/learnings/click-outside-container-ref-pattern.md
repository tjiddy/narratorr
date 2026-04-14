---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.tsx, src/client/hooks/useClickOutside.ts]
issue: 549
date: 2026-04-14
---
When migrating click-outside detection to a shared hook, components that don't own both trigger and panel refs can use a container ref wrapping both elements instead of threading individual refs. LibraryBookCard already had a container div around both the trigger button and BookContextMenu — adding a ref to that container was simpler than exposing menuRef from BookContextMenu via forwardRef.
