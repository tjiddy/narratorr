---
scope: [frontend]
files: [src/client/pages/book/BookHero.tsx, src/client/index.css]
issue: 450
date: 2026-04-09
---
`@media (hover: none)` is the CSS Level 4 way to detect primary non-hover (touch) devices. Hybrid devices like Surface report `hover: hover` since their primary input supports hover — no special handling needed. This is a pure CSS solution that avoids JS-based device detection. The `no-hover:` Tailwind variant is now available for any component that uses hover-gated visibility.
