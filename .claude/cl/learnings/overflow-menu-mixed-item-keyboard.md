---
scope: [frontend]
files: [src/client/pages/library/OverflowMenu.tsx]
issue: 124
date: 2026-03-26
---
When a menu mixes `<button>` and `<Link>` (router link) items with `role="menuitem"`, keyboard handling needs special-casing: use `querySelectorAll('[role="menuitem"]:not([disabled])')` for focusable item discovery (not `querySelectorAll('button')`) so the Link is included, and gate Space activation with `if (items[focusIndex]?.tagName !== 'A')` — browsers fire click on links for Enter natively via `.click()`, but Space does not activate links, matching ARIA authoring practice.
